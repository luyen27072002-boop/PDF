/* Local PDF Editor - no build step, served by FastAPI */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    pdfInput: $('#pdfInput'), imageInput: $('#imageInput'), fileName: $('#fileName'), status: $('#status'), message: $('#message'),
    zoomRange: $('#zoomRange'), zoomLabel: $('#zoomLabel'), renderMode: $('#renderMode'), exportMode: $('#exportMode'),
    fontFamily: $('#fontFamily'), fontSize: $('#fontSize'), letterSpacing: $('#letterSpacing'), lineHeight: $('#lineHeight'), colorInput: $('#colorInput'), boldBtn: $('#boldBtn'), italicBtn: $('#italicBtn'), textAlign: $('#textAlign'), preserveStyle: $('#preserveStyle'), eraseMode: $('#eraseMode'), coverOldText: $('#coverOldText'), coverColor: $('#coverColor'), cleanPreview: $('#cleanPreview'), hideEditGuides: $('#hideEditGuides'), stampText: $('#stampText'),
    pageWrap: $('#pageWrap'), pdfCanvas: $('#pdfCanvas'), serverImage: $('#serverImage'), annotationLayer: $('#annotationLayer'), drawCanvas: $('#drawCanvas'),
    thumbs: $('#thumbs'), pageInput: $('#pageInput'), prevBtn: $('#prevBtn'), nextBtn: $('#nextBtn'), rotateLeftBtn: $('#rotateLeftBtn'), rotateRightBtn: $('#rotateRightBtn'),
    deletePageBtn: $('#deletePageBtn'), moveUpBtn: $('#moveUpBtn'), moveDownBtn: $('#moveDownBtn'), exportBtn: $('#exportBtn'), printBtn: $('#printBtn'),
    undoBtn: $('#undoBtn'), redoBtn: $('#redoBtn'), manageBtn: $('#manageBtn'), manageDialog: $('#manageDialog'), closeManage: $('#closeManage'),
    dialogRotateLeft: $('#dialogRotateLeft'), dialogRotateRight: $('#dialogRotateRight'), dialogMoveUp: $('#dialogMoveUp'), dialogMoveDown: $('#dialogMoveDown'), dialogDelete: $('#dialogDelete'),
    searchBtn: $('#searchBtn'), searchDialog: $('#searchDialog'), searchInput: $('#searchInput'), runSearchBtn: $('#runSearchBtn'), closeSearch: $('#closeSearch'), searchResults: $('#searchResults'),
    textLayer: $('#textLayer'), extractTextBtn: $('#extractTextBtn'), textDialog: $('#textDialog'), extractedText: $('#extractedText'), copyTextBtn: $('#copyTextBtn'), closeTextDialog: $('#closeTextDialog')
  };

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  let docMeta = null;
  let pdfBytes = null;
  let pdfJsDoc = null;
  let pageOrder = [];
  let pageStates = {};
  let textCache = {};
  let currentIndex = 0;
  let zoom = 1;
  let currentTool = 'pan';
  let selectedId = null;
  let pendingImageData = null;
  let bold = false;
  let italic = false;
  let undoStack = [];
  let redoStack = [];
  let objectUrls = [];
  let editingTextId = null;
  let renderSerial = 0;

  const rectTools = new Set(['highlight', 'textHighlight', 'whiteout', 'redact', 'editText']);

  function uid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function cssColor(value, fallback = '#111111') {
    if (!value) return fallback;
    const v = String(value).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    return fallback;
  }

  function normalizeFontFamily(name) {
    // PDF thường nhúng font dạng subset như ABCDEF+TimesNewRomanPSMT.
    // Hàm này gom các tên font đó về font hệ thống gần nhất để chữ mới giống chữ cũ hơn.
    let n = String(name || '').toLowerCase();
    if (n.includes('+')) n = n.split('+').pop();
    n = n.replace(/[\s_-]/g, '');
    if (n.includes('times') || n.includes('roman') || n.includes('serif') || n.includes('cambria') || n.includes('georgia') || n.includes('liberationserif') || n.includes('nimbusroman')) return 'Times New Roman';
    if (n.includes('courier') || n.includes('mono') || n.includes('consolas') || n.includes('liberationmono')) return 'Courier New';
    if (n.includes('calibri')) return 'Calibri';
    if (n.includes('verdana')) return 'Verdana';
    if (n.includes('tahoma')) return 'Tahoma';
    if (n.includes('segoe')) return 'Segoe UI';
    if (n.includes('helvetica') || n.includes('arial') || n.includes('sans') || n.includes('liberationsans') || n.includes('nimbussans')) return 'Arial';
    return els.fontFamily?.value || 'Arial';
  }

  function setSelectIfExists(select, value) {
    if (!select) return;
    const option = Array.from(select.options).find(o => o.value === value || o.textContent === value);
    if (option) select.value = option.value;
  }

  function setStatus(text, warn = false) {
    els.status.textContent = text;
    els.message.textContent = text;
    els.message.classList.toggle('warn', warn);
  }

  function snapshot() {
    return JSON.stringify({ pageOrder, pageStates, currentIndex });
  }

  function pushHistory() {
    if (!docMeta) return;
    undoStack.push(snapshot());
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
    updateButtons();
  }

  function restore(snap) {
    const data = JSON.parse(snap);
    pageOrder = data.pageOrder;
    pageStates = data.pageStates;
    currentIndex = Math.max(0, Math.min(data.currentIndex || 0, pageOrder.length - 1));
    selectedId = null;
    renderPage();
    renderThumbs();
    updateButtons();
  }

  function updateButtons() {
    const hasDoc = !!docMeta;
    els.undoBtn.disabled = undoStack.length === 0;
    els.redoBtn.disabled = redoStack.length === 0;
    els.exportBtn.disabled = !hasDoc;
    els.prevBtn.disabled = !hasDoc || currentIndex <= 0;
    els.nextBtn.disabled = !hasDoc || currentIndex >= pageOrder.length - 1;
    els.rotateLeftBtn.disabled = !hasDoc;
    els.rotateRightBtn.disabled = !hasDoc;
    els.deletePageBtn.disabled = !hasDoc;
    els.moveUpBtn.disabled = !hasDoc || currentIndex <= 0;
    els.moveDownBtn.disabled = !hasDoc || currentIndex >= pageOrder.length - 1;
  }

  function sourcePage() {
    return pageOrder[currentIndex] || 1;
  }

  function originalSize(src = sourcePage()) {
    const p = docMeta?.pages?.find(x => Number(x.page) === Number(src));
    return { width: p?.width || 595, height: p?.height || 842 };
  }

  function baseSize(src = sourcePage()) {
    const st = pageStates[src] || { rotation: 0 };
    const p = originalSize(src);
    const rot = ((st.rotation || 0) % 360 + 360) % 360;
    if (rot === 90 || rot === 270) return { width: p.height, height: p.width };
    return { width: p.width, height: p.height };
  }

  function state(src = sourcePage()) {
    if (!pageStates[src]) {
      const size = originalSize(src);
      pageStates[src] = { sourcePage: src, rotation: 0, deleted: false, annotations: [], width: size.width, height: size.height };
    }
    return pageStates[src];
  }

  function selectedAnn() {
    return state().annotations.find(a => a.id === selectedId) || null;
  }

  function hasTextErase(src = sourcePage()) {
    const st = state(src);
    return (st.annotations || []).some(a =>
      (a.type === 'edit_text' && a.eraseMode === 'text') || a.type === 'edit_text_erase'
    );
  }

  function pagePayload(src = sourcePage()) {
    const st = state(src);
    const s = baseSize(src);
    return {
      sourcePage: src,
      rotation: st.rotation || 0,
      deleted: !!st.deleted,
      baseWidth: s.width,
      baseHeight: s.height,
      annotations: st.annotations || []
    };
  }

  function setTool(tool) {
    currentTool = tool;
    $$('.tool[data-tool]').forEach(btn => btn.classList.toggle('active', btn.dataset.tool === tool));
    els.annotationLayer.style.cursor = tool === 'pan' ? 'default' : 'crosshair';
    if (tool !== 'pan') stopTextEditing();
    const help = {
      pan: 'Đang xem. Chọn công cụ rồi click hoặc kéo trên trang.',
      text: 'Add text: click vào vị trí muốn thêm chữ.',
      editText: 'Edit text: click chữ để xóa chữ gốc nhưng giữ nền/watermark, rồi nhập chữ mới. Có thể chỉnh font, size, màu, đậm/nghiêng.',
      sign: 'Sign: giữ chuột và ký trực tiếp trên trang.',
      line: 'Line: kéo để vẽ đường thẳng.',
      draw: 'Draw: giữ chuột và vẽ.',
      eraser: 'Eraser: click vào đối tượng đã thêm để xóa.',
      whiteout: 'Whiteout: kéo vùng cần che trắng.',
      redact: 'Redact: kéo vùng cần che đen.',
      highlight: 'Highlight: kéo vùng cần tô nổi bật.',
      textHighlight: 'Text highlight: kéo vùng chữ cần tô.',
      image: 'Image: click vào trang để đặt ảnh đã chọn.',
      stamp: 'Stamp: click để đặt dấu.',
      link: 'Link: click để thêm nhãn link.',
      note: 'Note: click để thêm ghi chú.'
    };
    if (docMeta) {
      setStatus(help[tool] || help.pan);
      renderTextLayer();
    }
  }

  function cleanObjectUrls() {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls = [];
  }

  async function loadPdfJs() {
    pdfJsDoc = null;
    if (!window.pdfjsLib || !pdfBytes) return;
    try {
      const copy = pdfBytes.slice(0);
      const task = pdfjsLib.getDocument({
        data: copy,
        enableXfa: true,
        renderInteractiveForms: true,
        disableFontFace: false,
        useSystemFonts: true,
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/'
      });
      pdfJsDoc = await task.promise;
    } catch (err) {
      console.warn('PDF.js load failed', err);
    }
  }

  async function uploadPdf(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || 'Upload lỗi');
    }
    return res.json();
  }

  els.pdfInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('Đang upload và đọc PDF...');
    try {
      cleanObjectUrls();
      docMeta = null;
      pdfBytes = await file.arrayBuffer();
      const [meta] = await Promise.all([uploadPdf(file), loadPdfJs()]);
      docMeta = meta;
      await loadPdfJs();
      pageOrder = meta.pages.map(p => p.page);
      pageStates = {};
      textCache = {};
      pageOrder.forEach(p => state(p));
      currentIndex = 0;
      undoStack = [];
      redoStack = [];
      selectedId = null;
      els.fileName.textContent = `${meta.fileName} - ${meta.pageCount} trang`;
      els.pageWrap.classList.remove('empty');
      setTool('pan');
      await renderPage();
      renderThumbs();
      updateButtons();
      setStatus(`Đã mở ${meta.fileName}. Render mặc định bằng PDFium backend để tránh lỗi trắng trang.`);
    } catch (err) {
      console.error(err);
      setStatus(`Lỗi mở PDF: ${err.message}`, true);
    }
  });

  async function renderPage(fallbackTried = false) {
    if (!docMeta) return;
    const serial = ++renderSerial;
    const src = sourcePage();
    const st = state(src);
    const size = baseSize(src);
    const cssW = size.width * zoom;
    const cssH = size.height * zoom;
    els.pageInput.value = currentIndex + 1;
    els.pageWrap.style.width = `${cssW}px`;
    els.pageWrap.style.height = `${cssH}px`;
    els.annotationLayer.style.width = `${cssW}px`;
    els.annotationLayer.style.height = `${cssH}px`;
    els.textLayer.style.width = `${cssW}px`;
    els.textLayer.style.height = `${cssH}px`;
    els.drawCanvas.width = Math.round(cssW * devicePixelRatio);
    els.drawCanvas.height = Math.round(cssH * devicePixelRatio);
    els.drawCanvas.style.width = `${cssW}px`;
    els.drawCanvas.style.height = `${cssH}px`;
    els.drawCanvas.getContext('2d').setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    els.pageWrap.classList.toggle('hide-edit-guides', !!els.hideEditGuides?.checked);

    if (els.renderMode.value === 'pdfjs' && pdfJsDoc) {
      await renderPdfJsPage(src, st.rotation, serial);
    } else {
      await renderServerPage(src, st.rotation, serial, fallbackTried);
    }
    if (serial !== renderSerial) return;
    renderAnnotations();
    renderTextLayer();
    updateButtons();
    $$('.thumb').forEach((t, i) => t.classList.toggle('active', i === currentIndex));
    setStatus(`Đang xem trang ${currentIndex + 1}/${pageOrder.length}. Chọn công cụ rồi click hoặc kéo trên trang.`);
  }

  async function renderServerPage(src, rotation, serial, fallbackTried) {
    const size = baseSize(src);
    const cssW = size.width * zoom;
    const cssH = size.height * zoom;
    els.pdfCanvas.style.display = 'none';
    els.serverImage.style.display = 'block';
    try {
      const scale = Math.max(0.5, Math.min(3.5, zoom * window.devicePixelRatio));
      const useClean = !!els.cleanPreview?.checked && hasTextErase(src);
      const res = useClean
        ? await fetch('/api/render_clean', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ docId: docMeta.docId, page: src, scale, rotation, pagePayload: pagePayload(src) })
          })
        : await fetch(`/api/render/${docMeta.docId}/${src}?scale=${scale}&rotation=${rotation}`);
      if (!res.ok) throw new Error(await res.text());
      const looksBlank = res.headers.get('X-Looks-Blank') === '1';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      if (serial !== renderSerial) return;
      els.serverImage.src = url;
      els.serverImage.style.width = `${cssW}px`;
      els.serverImage.style.height = `${cssH}px`;
      if (looksBlank && pdfJsDoc && !fallbackTried) {
        els.renderMode.value = 'pdfjs';
        setStatus('PDFium render ra nền trắng. Đang tự chuyển sang PDF.js/XFA...', true);
        await renderPage(true);
      }
    } catch (err) {
      console.warn('Server render failed', err);
      if (pdfJsDoc && !fallbackTried) {
        els.renderMode.value = 'pdfjs';
        await renderPage(true);
      } else {
        throw err;
      }
    }
  }

  async function renderPdfJsPage(src, rotation, serial) {
    const page = await pdfJsDoc.getPage(src);
    const viewport = page.getViewport({ scale: zoom, rotation });
    const dpr = window.devicePixelRatio || 1;
    const canvas = els.pdfCanvas;
    canvas.style.display = 'block';
    els.serverImage.style.display = 'none';
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    const renderContext = {
      canvasContext: ctx,
      viewport,
      transform,
      annotationMode: pdfjsLib.AnnotationMode ? pdfjsLib.AnnotationMode.ENABLE_FORMS : undefined,
      intent: 'display'
    };
    await page.render(renderContext).promise;
    if (serial !== renderSerial) return;
    const size = baseSize(src);
    if (Math.abs(size.width * zoom - viewport.width) > 2 || Math.abs(size.height * zoom - viewport.height) > 2) {
      els.pageWrap.style.width = `${viewport.width}px`;
      els.pageWrap.style.height = `${viewport.height}px`;
      els.annotationLayer.style.width = `${viewport.width}px`;
      els.annotationLayer.style.height = `${viewport.height}px`;
      els.textLayer.style.width = `${viewport.width}px`;
      els.textLayer.style.height = `${viewport.height}px`;
    }
  }

  function renderThumbs() {
    if (!docMeta) return;
    els.thumbs.innerHTML = '';
    pageOrder.forEach((src, idx) => {
      const div = document.createElement('div');
      div.className = `thumb ${idx === currentIndex ? 'active' : ''} ${state(src).deleted ? 'deleted' : ''}`;
      const img = document.createElement('img');
      img.alt = `Trang ${idx + 1}`;
      const rot = state(src).rotation || 0;
      img.src = `/api/render/${docMeta.docId}/${src}?scale=0.22&rotation=${rot}&t=${Date.now()}`;
      const label = document.createElement('span');
      label.textContent = state(src).deleted ? `${idx + 1} đã xóa` : String(idx + 1);
      div.appendChild(img);
      div.appendChild(label);
      div.addEventListener('click', async () => {
        currentIndex = idx;
        selectedId = null;
        await renderPage();
      });
      els.thumbs.appendChild(div);
    });
  }


  function textCacheKey(src = sourcePage()) {
    return `${docMeta?.docId || 'none'}:${src}`;
  }

  async function loadTextItems(src = sourcePage()) {
    if (!docMeta) return { items: [], text: '', hasText: false, engine: 'none' };
    const key = textCacheKey(src);
    if (textCache[key]) return textCache[key];
    try {
      const res = await fetch(`/api/text/${docMeta.docId}/${src}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      textCache[key] = data;
      return data;
    } catch (err) {
      console.warn('Cannot load text layer', err);
      const empty = { items: [], text: '', hasText: false, engine: 'error' };
      textCache[key] = empty;
      return empty;
    }
  }

  function rotateRect(rect, rot, src = sourcePage()) {
    const p = originalSize(src);
    const r = ((rot || 0) % 360 + 360) % 360;
    const x = Number(rect.x) || 0, y = Number(rect.y) || 0;
    const w = Number(rect.w) || 0, h = Number(rect.h) || 0;
    if (r === 90) return { x: p.height - (y + h), y: x, w: h, h: w };
    if (r === 180) return { x: p.width - (x + w), y: p.height - (y + h), w, h };
    if (r === 270) return { x: y, y: p.width - (x + w), w: h, h: w };
    return { x, y, w, h };
  }

  async function renderTextLayer() {
    if (!els.textLayer) return;
    els.textLayer.innerHTML = '';
    const canPickPdfText = currentTool === 'editText' && !editingTextId;
    els.textLayer.classList.toggle('active', canPickPdfText);
    els.pageWrap.classList.toggle('text-active', canPickPdfText);
    if (!docMeta || !canPickPdfText) return;

    const src = sourcePage();
    const data = await loadTextItems(src);
    if (sourcePage() !== src || currentTool !== 'editText') return;
    if (!data.hasText || !data.items?.length) {
      setStatus('Trang này không có text layer. Nếu là ảnh scan thì cần OCR; vẫn có thể kéo vùng để che và ghi chữ mới.', true);
      return;
    }

    const st = state(src);
    data.items.forEach((item, idx) => {
      const r = rotateRect(item, st.rotation || 0, src);
      const div = document.createElement('div');
      div.className = 'text-item';
      div.dataset.text = item.text || '';
      div.dataset.itemIndex = String(idx);
      div.title = item.text || '';
      div.style.left = `${r.x * zoom}px`;
      div.style.top = `${r.y * zoom}px`;
      div.style.width = `${Math.max(2, r.w * zoom)}px`;
      div.style.height = `${Math.max(2, r.h * zoom)}px`;
      div.style.fontSize = `${Math.max(6, r.h * zoom)}px`;
      div.textContent = item.text || '';
      div.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        createEditFromTextItem(item, r);
      });
      els.textLayer.appendChild(div);
    });
    setStatus(`Đã nhận diện ${data.items.length} dòng/chữ trên trang. Click vào chữ để sửa.`);
  }

  function createEditFromTextItem(item, rectInView) {
    if (!item || !rectInView) return;
    pushHistory();
    const box = {
      x: Math.max(0, rectInView.x),
      y: Math.max(0, rectInView.y),
      w: Math.max(1, rectInView.w),
      h: Math.max(1, rectInView.h),
    };
    const keepStyle = !!els.preserveStyle?.checked;
    const fontFamily = keepStyle ? normalizeFontFamily(item.fontFamily) : (els.fontFamily.value || 'Arial');
    const fontSize = keepStyle ? Math.max(6, Math.round(Number(item.fontSize) || box.h * 0.92)) : (Number(els.fontSize.value) || 18);
    const color = keepStyle ? cssColor(item.color, els.colorInput.value || '#111111') : (els.colorInput.value || '#111111');
    const itemBold = keepStyle ? !!item.bold : bold;
    const itemItalic = keepStyle ? !!item.italic : italic;
    if (keepStyle) {
      setSelectIfExists(els.fontFamily, fontFamily);
      if (els.fontSize) els.fontSize.value = fontSize;
      if (els.colorInput) els.colorInput.value = color;
      bold = itemBold; italic = itemItalic;
      els.boldBtn.classList.toggle('active', bold);
      els.italicBtn.classList.toggle('active', italic);
    }
    const eraseMode = els.eraseMode?.value || 'text';
    const anns = [];
    if (eraseMode === 'whiteout') {
      anns.push(makeAnn({ type: 'edit_whiteout', x: box.x, y: box.y, w: box.w, h: box.h, color: els.coverColor?.value || '#ffffff', sourceText: item.text || '', sourceTextId: item.id || null }));
    }
    const txt = makeAnn({
      type: 'edit_text',
      x: box.x,
      y: box.y,
      w: Math.max(8, box.w),
      h: Math.max(8, box.h),
      text: item.text || 'Sửa text',
      eraseMode,
      fontSize,
      fontFamily,
      color,
      bold: itemBold,
      italic: itemItalic,
      align: els.textAlign?.value || 'left',
      letterSpacing: Number(els.letterSpacing?.value) || 0,
      lineHeight: Number(els.lineHeight?.value) || 1,
      sourceText: item.text || '',
      sourceTextId: item.id || null,
      sourceStyle: { fontFamily, fontSize, color, bold: itemBold, italic: itemItalic },
      sourceBox: { x: item.x, y: item.y, w: item.w, h: item.h }
    });
    anns.push(txt);
    state().annotations.push(...anns);
    selectedId = txt.id;
    renderPage().then(() => startTextEditing(txt.id));
  }

  function makeAnn(ann) {
    return {
      id: uid(),
      color: els.colorInput.value,
      fontSize: Number(els.fontSize.value) || 18,
      fontFamily: els.fontFamily.value,
      bold,
      italic,
      align: els.textAlign?.value || 'left',
      letterSpacing: Number(els.letterSpacing?.value) || 0,
      lineHeight: Number(els.lineHeight?.value) || 1,
      ...ann
    };
  }

  function addAnnotation(ann, select = true) {
    pushHistory();
    const a = makeAnn(ann);
    state().annotations.push(a);
    if (select) selectedId = a.id;
    renderAnnotations();
    if (select && ['text', 'edit_text', 'note'].includes(a.type)) startTextEditing(a.id);
    return a;
  }

  function deleteAnnotation(id = selectedId) {
    if (!id) return;
    const st = state();
    const idx = st.annotations.findIndex(a => a.id === id);
    if (idx >= 0) {
      pushHistory();
      st.annotations.splice(idx, 1);
      selectedId = null;
      renderAnnotations();
    }
  }

  function startTextEditing(id) {
    editingTextId = id;
    selectedId = id;
    syncFormatControlsFromSelected();
    renderTextLayer();
    renderAnnotations(false);
    requestAnimationFrame(() => {
      const el = els.annotationLayer.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.setAttribute('contenteditable', 'true');
      el.focus();
      document.execCommand?.('selectAll', false, null);
    });
  }

  function stopTextEditing() {
    if (!editingTextId) return;
    const el = els.annotationLayer.querySelector(`[data-id="${CSS.escape(editingTextId)}"]`);
    const ann = pageStates[sourcePage()]?.annotations.find(a => a.id === editingTextId);
    if (el && ann) ann.text = el.innerText;
    editingTextId = null;
    renderAnnotations(false);
    renderTextLayer();
  }

  function selectAnnotation(id) {
    if (currentTool === 'eraser') {
      deleteAnnotation(id);
      return;
    }
    if (editingTextId && editingTextId !== id) stopTextEditing();
    selectedId = id;
    syncFormatControlsFromSelected();
    renderAnnotations(false);
  }

  function renderAnnotations(rebuild = true) {
    const st = state();
    if (rebuild) els.annotationLayer.innerHTML = '';
    if (!rebuild) {
      $$('.ann').forEach(el => el.classList.toggle('selected', el.dataset.id === selectedId));
      return;
    }

    const size = baseSize();
    st.annotations.forEach(ann => {
      if (ann.type === 'edit_text_erase') return;
      const el = document.createElement('div');
      el.className = `ann ${ann.type} ${ann.id === selectedId ? 'selected' : ''}`;
      el.dataset.id = ann.id;
      const x = (ann.x || 0) * zoom;
      const y = (ann.y || 0) * zoom;
      const w = (ann.w || size.width) * zoom;
      const h = (ann.h || size.height) * zoom;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${Math.max(4, w)}px`;
      el.style.height = `${Math.max(4, h)}px`;

      if (['text', 'edit_text'].includes(ann.type)) {
        el.textContent = ann.text || 'ABC';
        el.style.color = ann.color || '#111';
        el.style.fontSize = `${(ann.fontSize || 18) * zoom}px`;
        el.style.fontFamily = ann.fontFamily || 'Arial';
        el.style.fontWeight = ann.bold ? '800' : '400';
        el.style.fontStyle = ann.italic ? 'italic' : 'normal';
        el.style.textAlign = ann.align || 'left';
        el.style.letterSpacing = `${Number(ann.letterSpacing || 0) * zoom}px`;
        el.style.lineHeight = String(Number(ann.lineHeight || 1) || 1);
        if (editingTextId === ann.id) el.setAttribute('contenteditable', 'true');
        el.addEventListener('input', () => { ann.text = el.innerText; });
        el.addEventListener('dblclick', (e) => { e.stopPropagation(); startTextEditing(ann.id); });
      } else if (ann.type === 'image') {
        const img = document.createElement('img');
        img.src = ann.dataUrl;
        el.appendChild(img);
      } else if (ann.type === 'stamp') {
        el.textContent = ann.text || 'PAID';
        el.style.color = ann.color || '#d10000';
        el.style.borderColor = ann.color || '#d10000';
        el.style.fontSize = `${(ann.fontSize || 28) * zoom}px`;
      } else if (ann.type === 'note') {
        el.textContent = ann.text || 'Ghi chú';
        el.style.fontSize = `${(ann.fontSize || 14) * zoom}px`;
        el.style.fontFamily = ann.fontFamily || 'Arial';
        el.style.color = ann.color || '#111111';
        el.style.fontWeight = ann.bold ? '800' : '400';
        el.style.fontStyle = ann.italic ? 'italic' : 'normal';
        el.style.textAlign = ann.align || 'left';
        el.style.letterSpacing = `${Number(ann.letterSpacing || 0) * zoom}px`;
        el.style.lineHeight = String(Number(ann.lineHeight || 1) || 1);
        if (editingTextId === ann.id) el.setAttribute('contenteditable', 'true');
        el.addEventListener('input', () => { ann.text = el.innerText; });
        el.addEventListener('dblclick', (e) => { e.stopPropagation(); startTextEditing(ann.id); });
      } else if (ann.type === 'link') {
        el.textContent = ann.text || ann.href || 'Link';
        el.style.fontSize = `${(ann.fontSize || 14) * zoom}px`;
        el.style.fontFamily = ann.fontFamily || 'Arial';
        el.style.color = ann.color || '#0645ad';
      } else if (ann.type === 'line') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        const ax1 = ann.x1 ?? ann.x;
        const ay1 = ann.y1 ?? ann.y;
        const ax2 = ann.x2 ?? ann.x + ann.w;
        const ay2 = ann.y2 ?? ann.y + ann.h;
        const minX = Math.min(ax1, ax2);
        const minY = Math.min(ay1, ay2);
        const x1 = (ax1 - minX) * zoom;
        const y1 = (ay1 - minY) * zoom;
        const x2 = (ax2 - minX) * zoom;
        const y2 = (ay2 - minY) * zoom;
        line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2);
        line.setAttribute('stroke', ann.color || '#111');
        line.setAttribute('stroke-width', Math.max(1, (ann.strokeWidth || 2) * zoom));
        line.setAttribute('stroke-linecap', 'round');
        svg.appendChild(line); el.appendChild(svg);
      } else if (['draw', 'sign'].includes(ann.type)) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const d = (ann.points || []).map((p, i) => `${i ? 'L' : 'M'} ${p.x * zoom} ${p.y * zoom}`).join(' ');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', ann.color || '#111');
        path.setAttribute('stroke-width', Math.max(1, (ann.strokeWidth || (ann.type === 'sign' ? 3 : 2)) * zoom));
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path); el.appendChild(svg);
        el.style.pointerEvents = 'none';
      }

      const handle = document.createElement('span');
      handle.className = 'resize-handle';
      el.appendChild(handle);

      el.addEventListener('pointerdown', (e) => onAnnotationPointerDown(e, ann, el));
      handle.addEventListener('pointerdown', (e) => onResizePointerDown(e, ann, el));
      els.annotationLayer.appendChild(el);
    });
  }

  function onAnnotationPointerDown(e, ann, el) {
    if (editingTextId === ann.id) return;
    e.preventDefault();
    e.stopPropagation();
    selectAnnotation(ann.id);
    if (currentTool === 'eraser') return;
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = ann.x || 0;
    const oy = ann.y || 0;
    const ox2 = ann.x2;
    const oy2 = ann.y2;
    const ox1 = ann.x1;
    const oy1 = ann.y1;
    let moved = false;
    pushHistory();
    const move = (ev) => {
      moved = true;
      ann.x = ox + (ev.clientX - startX) / zoom;
      ann.y = oy + (ev.clientY - startY) / zoom;
      el.style.left = `${ann.x * zoom}px`;
      el.style.top = `${ann.y * zoom}px`;
      if (ann.type === 'line') {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        ann.x1 = (ox1 ?? ox) + dx;
        ann.y1 = (oy1 ?? oy) + dy;
        ann.x2 = (ox2 ?? ox + ann.w) + dx;
        ann.y2 = (oy2 ?? oy + ann.h) + dy;
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        // keep history clean for simple selection
        undoStack.pop();
        updateButtons();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onResizePointerDown(e, ann, el) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const ow = ann.w || 100, oh = ann.h || 40;
    pushHistory();
    const move = (ev) => {
      ann.w = Math.max(8, ow + (ev.clientX - startX) / zoom);
      ann.h = Math.max(8, oh + (ev.clientY - startY) / zoom);
      el.style.width = `${ann.w * zoom}px`;
      el.style.height = `${ann.h * zoom}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function pagePoint(e) {
    const r = els.pageWrap.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  }

  function clampRect(r) {
    const size = baseSize();
    const x = Math.max(0, Math.min(r.x, r.x + r.w));
    const y = Math.max(0, Math.min(r.y, r.y + r.h));
    const w = Math.abs(r.w);
    const h = Math.abs(r.h);
    return {
      x: Math.min(x, size.width),
      y: Math.min(y, size.height),
      w: Math.min(w, size.width - Math.min(x, size.width)),
      h: Math.min(h, size.height - Math.min(y, size.height))
    };
  }

  els.annotationLayer.addEventListener('pointerdown', (e) => {
    if (!docMeta) return;
    if (e.target !== els.annotationLayer) return;
    stopTextEditing();
    selectedId = null;
    renderAnnotations(false);
    const p = pagePoint(e);

    if (currentTool === 'text') {
      addAnnotation({ type: 'text', x: p.x, y: p.y, w: 190, h: 42, text: 'ABC' });
      return;
    }
    if (currentTool === 'image') {
      if (!pendingImageData) { setStatus('Hãy chọn ảnh trước.', true); return; }
      addAnnotation({ type: 'image', x: p.x, y: p.y, w: 180, h: 120, dataUrl: pendingImageData });
      return;
    }
    if (currentTool === 'stamp') {
      addAnnotation({ type: 'stamp', x: p.x, y: p.y, w: 190, h: 70, text: els.stampText.value, color: '#d10000', fontSize: 28, bold: true });
      return;
    }
    if (currentTool === 'note') {
      addAnnotation({ type: 'note', x: p.x, y: p.y, w: 180, h: 110, text: 'Ghi chú', fontSize: 14, color: '#111111' });
      return;
    }
    if (currentTool === 'link') {
      const href = prompt('Nhập URL:', 'https://');
      if (!href) return;
      addAnnotation({ type: 'link', x: p.x, y: p.y, w: 220, h: 28, text: href, href, color: '#0645ad', fontSize: 14 });
      return;
    }
    if (currentTool === 'draw' || currentTool === 'sign') {
      beginFreeDraw(e, currentTool);
      return;
    }
    if (currentTool === 'line') {
      beginLine(e);
      return;
    }
    if (rectTools.has(currentTool)) {
      beginRect(e, currentTool);
      return;
    }
  });

  function beginRect(e, tool) {
    const start = pagePoint(e);
    const rectEl = document.createElement('div');
    rectEl.className = 'selection-rect';
    els.annotationLayer.appendChild(rectEl);
    const move = (ev) => {
      const now = pagePoint(ev);
      const r = clampRect({ x: start.x, y: start.y, w: now.x - start.x, h: now.y - start.y });
      rectEl.style.left = `${r.x * zoom}px`;
      rectEl.style.top = `${r.y * zoom}px`;
      rectEl.style.width = `${r.w * zoom}px`;
      rectEl.style.height = `${r.h * zoom}px`;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      rectEl.remove();
      const end = pagePoint(ev);
      const r = clampRect({ x: start.x, y: start.y, w: end.x - start.x, h: end.y - start.y });
      if (r.w < 5 || r.h < 5) return;
      if (tool === 'editText') {
        pushHistory();
        const eraseMode = els.eraseMode?.value || 'text';
        const anns = [];
        if (eraseMode === 'whiteout') {
          anns.push(makeAnn({ type: 'edit_whiteout', x: r.x, y: r.y, w: r.w, h: r.h, color: els.coverColor?.value || '#ffffff' }));
        } else if (eraseMode === 'text') {
          anns.push(makeAnn({ type: 'edit_text_erase', x: r.x, y: r.y, w: r.w, h: r.h }));
        }
        const txt = makeAnn({ type: 'edit_text', x: r.x, y: r.y, w: Math.max(8, r.w), h: Math.max(8, r.h), text: 'Sửa text', align: els.textAlign?.value || 'left', eraseMode, letterSpacing: Number(els.letterSpacing?.value) || 0, lineHeight: Number(els.lineHeight?.value) || 1 });
        state().annotations.push(...anns, txt);
        selectedId = txt.id;
        renderPage().then(() => startTextEditing(txt.id));
        return;
      }
      const typeMap = { textHighlight: 'text_highlight' };
      addAnnotation({ type: typeMap[tool] || tool, x: r.x, y: r.y, w: r.w, h: r.h, color: tool === 'redact' ? '#000000' : (tool === 'whiteout' ? '#ffffff' : '#ffeb3b') }, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function beginLine(e) {
    const start = pagePoint(e);
    const ctx = els.drawCanvas.getContext('2d');
    const size = baseSize();
    const drawTemp = (ev) => {
      const now = pagePoint(ev);
      ctx.clearRect(0, 0, size.width * zoom, size.height * zoom);
      ctx.strokeStyle = els.colorInput.value;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(start.x * zoom, start.y * zoom);
      ctx.lineTo(now.x * zoom, now.y * zoom);
      ctx.stroke();
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', drawTemp);
      window.removeEventListener('pointerup', up);
      ctx.clearRect(0, 0, size.width * zoom, size.height * zoom);
      const end = pagePoint(ev);
      if (Math.hypot(end.x - start.x, end.y - start.y) < 4) return;
      const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
      addAnnotation({ type: 'line', x, y, w, h, x1: start.x, y1: start.y, x2: end.x, y2: end.y, strokeWidth: 2 });
    };
    window.addEventListener('pointermove', drawTemp);
    window.addEventListener('pointerup', up);
  }

  function beginFreeDraw(e, type) {
    const ctx = els.drawCanvas.getContext('2d');
    const size = baseSize();
    const points = [pagePoint(e)];
    ctx.clearRect(0, 0, size.width * zoom, size.height * zoom);
    ctx.strokeStyle = els.colorInput.value;
    ctx.lineWidth = type === 'sign' ? 3 : 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x * zoom, points[0].y * zoom);
    const move = (ev) => {
      const p = pagePoint(ev);
      points.push(p);
      ctx.lineTo(p.x * zoom, p.y * zoom);
      ctx.stroke();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ctx.clearRect(0, 0, size.width * zoom, size.height * zoom);
      if (points.length < 2) return;
      addAnnotation({ type, x: 0, y: 0, w: size.width, h: size.height, points, strokeWidth: type === 'sign' ? 3 : 2 });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  $$('.tool[data-tool]').forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));

  els.imageInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingImageData = reader.result;
      setTool('image');
      setStatus('Ảnh đã sẵn sàng. Click vào trang để đặt ảnh.');
    };
    reader.readAsDataURL(file);
  });

  els.zoomRange.addEventListener('input', () => {
    zoom = Number(els.zoomRange.value) / 100;
    els.zoomLabel.textContent = `${els.zoomRange.value}%`;
    renderPage();
  });
  els.renderMode.addEventListener('change', () => renderPage());
  els.boldBtn.addEventListener('click', () => { bold = !bold; els.boldBtn.classList.toggle('active', bold); applyTextStyleToSelected(); });
  els.italicBtn.addEventListener('click', () => { italic = !italic; els.italicBtn.classList.toggle('active', italic); applyTextStyleToSelected(); });
  [els.fontFamily, els.fontSize, els.letterSpacing, els.lineHeight, els.colorInput, els.textAlign].filter(Boolean).forEach(el => el.addEventListener('change', applyTextStyleToSelected));
  [els.fontSize, els.letterSpacing, els.lineHeight, els.colorInput].filter(Boolean).forEach(el => el.addEventListener('input', applyTextStyleToSelected));
  [els.cleanPreview, els.hideEditGuides].filter(Boolean).forEach(el => el.addEventListener('change', () => renderPage()));

  function syncFormatControlsFromSelected() {
    const ann = selectedAnn();
    if (!ann || !['text', 'edit_text', 'stamp', 'note', 'link'].includes(ann.type)) return;
    setSelectIfExists(els.fontFamily, normalizeFontFamily(ann.fontFamily || 'Arial'));
    if (els.fontSize) els.fontSize.value = Math.max(6, Math.round(Number(ann.fontSize) || 18));
    if (els.colorInput) els.colorInput.value = cssColor(ann.color, '#111111');
    if (els.letterSpacing) els.letterSpacing.value = Number(ann.letterSpacing || 0);
    if (els.lineHeight) els.lineHeight.value = Number(ann.lineHeight || (ann.type === 'edit_text' ? 1 : 1.2));
    if (els.textAlign) els.textAlign.value = ann.align || 'left';
    bold = !!ann.bold;
    italic = !!ann.italic;
    els.boldBtn.classList.toggle('active', bold);
    els.italicBtn.classList.toggle('active', italic);
  }

  function applyTextStyleToSelected() {
    const ann = selectedAnn();
    if (!ann || !['text', 'edit_text', 'stamp', 'note', 'link'].includes(ann.type)) return;
    pushHistory();
    ann.fontFamily = els.fontFamily.value;
    ann.fontSize = Number(els.fontSize.value) || ann.fontSize || 18;
    ann.color = els.colorInput.value;
    ann.bold = bold;
    ann.italic = italic;
    ann.letterSpacing = Number(els.letterSpacing?.value) || 0;
    ann.lineHeight = Number(els.lineHeight?.value) || (ann.type === 'edit_text' ? 1 : 1.2);
    ann.align = els.textAlign?.value || ann.align || 'left';
    renderAnnotations();
  }

  els.prevBtn.addEventListener('click', () => { if (currentIndex > 0) { currentIndex--; selectedId = null; renderPage(); } });
  els.nextBtn.addEventListener('click', () => { if (currentIndex < pageOrder.length - 1) { currentIndex++; selectedId = null; renderPage(); } });
  els.pageInput.addEventListener('change', () => {
    const n = Math.max(1, Math.min(pageOrder.length, Number(els.pageInput.value) || 1));
    currentIndex = n - 1; selectedId = null; renderPage();
  });

  function rotate(delta) {
    if (!docMeta) return;
    pushHistory();
    const st = state();
    st.rotation = ((st.rotation || 0) + delta + 360) % 360;
    selectedId = null;
    renderPage();
    renderThumbs();
  }
  function deletePage() {
    if (!docMeta) return;
    const alive = pageOrder.filter(p => !state(p).deleted).length;
    if (alive <= 1) { setStatus('Không thể xóa hết tất cả trang.', true); return; }
    pushHistory();
    state().deleted = !state().deleted;
    renderPage();
    renderThumbs();
  }
  function movePage(dir) {
    const j = currentIndex + dir;
    if (j < 0 || j >= pageOrder.length) return;
    pushHistory();
    [pageOrder[currentIndex], pageOrder[j]] = [pageOrder[j], pageOrder[currentIndex]];
    currentIndex = j;
    renderPage();
    renderThumbs();
  }
  els.rotateLeftBtn.addEventListener('click', () => rotate(-90));
  els.rotateRightBtn.addEventListener('click', () => rotate(90));
  els.deletePageBtn.addEventListener('click', deletePage);
  els.moveUpBtn.addEventListener('click', () => movePage(-1));
  els.moveDownBtn.addEventListener('click', () => movePage(1));

  els.undoBtn.addEventListener('click', () => {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  });
  els.redoBtn.addEventListener('click', () => {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  });

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    const editable = document.activeElement?.getAttribute('contenteditable') === 'true';
    if (tag === 'input' || tag === 'textarea' || editable) return;
    if (e.key === 'Delete' || e.key === 'Backspace') deleteAnnotation();
    if (e.key === 'Escape') { selectedId = null; stopTextEditing(); setTool('pan'); renderAnnotations(false); }
    if (e.ctrlKey && e.key.toLowerCase() === 'z') els.undoBtn.click();
    if (e.ctrlKey && e.key.toLowerCase() === 'y') els.redoBtn.click();
  });

  function payloadPages() {
    return pageOrder.map(src => pagePayload(src)).filter(p => !p.deleted);
  }

  async function exportPdf(printAfter = false) {
    if (!docMeta) return;
    stopTextEditing();
    setStatus((els.exportMode?.value || 'native') === 'native' ? 'Đang xuất PDF native: xóa text gốc, giữ nền/vector...' : 'Đang xuất PDF flatten giống preview...');
    els.exportBtn.disabled = true;
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: docMeta.docId, fileName: docMeta.safeName || 'edited', scale: 2, exportMode: els.exportMode?.value || 'native', pages: payloadPages() })
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      if (printAfter) {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = url;
        document.body.appendChild(iframe);
        iframe.onload = () => iframe.contentWindow?.print();
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = `${docMeta.safeName || 'document'}-edited.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setStatus('Đã xuất PDF xong. Chữ cũ đã được xóa theo text layer; nền/watermark/đường kẻ được giữ lại, không có ô trắng.');
    } catch (err) {
      console.error(err);
      setStatus(`Xuất PDF lỗi: ${err.message}`, true);
    } finally {
      els.exportBtn.disabled = false;
    }
  }
  els.exportBtn.addEventListener('click', () => exportPdf(false));
  els.printBtn.addEventListener('click', () => exportPdf(true));

  els.manageBtn.addEventListener('click', () => els.manageDialog.showModal());
  els.closeManage.addEventListener('click', () => els.manageDialog.close());
  els.dialogRotateLeft.addEventListener('click', () => rotate(-90));
  els.dialogRotateRight.addEventListener('click', () => rotate(90));
  els.dialogMoveUp.addEventListener('click', () => movePage(-1));
  els.dialogMoveDown.addEventListener('click', () => movePage(1));
  els.dialogDelete.addEventListener('click', deletePage);


  async function showExtractedText() {
    if (!docMeta) return;
    const src = sourcePage();
    setStatus('Đang trích text trang hiện tại...');
    const data = await loadTextItems(src);
    els.extractedText.value = data.text || '';
    if (!data.hasText) {
      els.extractedText.value = 'Trang này không có text layer. Nếu PDF là ảnh scan hoặc form đặc biệt thì cần OCR để lấy chữ.';
    }
    els.textDialog.showModal();
    setStatus(data.hasText ? `Đã trích text bằng ${data.engine}.` : 'Không có text layer để trích.', !data.hasText);
  }

  els.extractTextBtn.addEventListener('click', showExtractedText);
  els.closeTextDialog.addEventListener('click', () => els.textDialog.close());
  els.copyTextBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.extractedText.value || '');
      setStatus('Đã copy text vào clipboard.');
    } catch (_) {
      els.extractedText.select();
      document.execCommand?.('copy');
      setStatus('Đã chọn/copy text.');
    }
  });

  els.searchBtn.addEventListener('click', () => els.searchDialog.showModal());
  els.closeSearch.addEventListener('click', () => els.searchDialog.close());
  els.runSearchBtn.addEventListener('click', runSearch);
  els.searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

  async function runSearch() {
    const q = els.searchInput.value.trim();
    els.searchResults.innerHTML = '';
    if (!q || !docMeta) return;
    setStatus('Đang tìm trong text layer của PDF...');
    try {
      const res = await fetch(`/api/search/${docMeta.docId}?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const results = data.results || [];
      if (!results.length) {
        els.searchResults.textContent = 'Không tìm thấy, hoặc PDF không có text layer. Nếu đây là ảnh scan thì cần OCR.';
        setStatus('Không tìm thấy kết quả trong text layer.', true);
        return;
      }
      results.forEach(r => {
        const div = document.createElement('div');
        div.className = 'search-result';
        div.innerHTML = `<b>Trang gốc ${r.page}</b><br>${escapeHtml(r.snippet || '')}`;
        div.addEventListener('click', async () => {
          const idx = pageOrder.indexOf(r.page);
          if (idx >= 0) {
            currentIndex = idx;
            await renderPage();
            setTool('editText');
            els.searchDialog.close();
          }
        });
        els.searchResults.appendChild(div);
      });
      setStatus(`Tìm thấy ${results.length} trang có kết quả.`);
    } catch (err) {
      console.error(err);
      setStatus(`Search lỗi: ${err.message}`, true);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }

  updateButtons();
  setTool('pan');
})();
