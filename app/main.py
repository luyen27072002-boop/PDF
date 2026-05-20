from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw, ImageFont

try:
    import pypdfium2 as pdfium
except Exception:  # pragma: no cover - lets the app explain a missing dependency at runtime
    pdfium = None

try:
    import fitz  # PyMuPDF - used for text extraction and vector-style exports
except Exception:  # pragma: no cover
    fitz = None

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "app" / "static"
UPLOAD_DIR = BASE_DIR / "storage" / "uploads"
EXPORT_DIR = BASE_DIR / "storage" / "exports"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Local PDFAid-like PDF Editor")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _safe_name(name: str) -> str:
    stem = Path(name).stem or "document"
    stem = re.sub(r"[^\w\-.()\[\] ]+", "_", stem, flags=re.UNICODE).strip(" .")
    return stem[:80] or "document"


def _doc_path(doc_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9\-]{36}", doc_id):
        raise HTTPException(status_code=400, detail="doc_id không hợp lệ")
    path = UPLOAD_DIR / f"{doc_id}.pdf"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF đã upload")
    return path


def _open_pdf(path: Path):
    if pdfium is None:
        raise HTTPException(
            status_code=500,
            detail="Thiếu pypdfium2. Hãy chạy: pip install -r requirements.txt",
        )
    return pdfium.PdfDocument(str(path))


def _page_size(page: Any) -> tuple[float, float]:
    try:
        return tuple(float(x) for x in page.get_size())
    except Exception:
        try:
            return float(page.get_width()), float(page.get_height())
        except Exception:
            return 595.0, 842.0


def _render_pdfium_page(path: Path, page_number: int, scale: float = 2.0, rotation: int = 0) -> Image.Image:
    pdf = _open_pdf(path)
    try:
        if page_number < 1 or page_number > len(pdf):
            raise HTTPException(status_code=404, detail="Trang không tồn tại")
        page = pdf[page_number - 1]
        try:
            # pypdfium2 normally accepts rotation in degrees. Some old builds accept only 0..3.
            bitmap = page.render(
                scale=scale,
                rotation=int(rotation) % 360,
                draw_annots=True,
                may_draw_forms=True,
            )
        except TypeError:
            try:
                bitmap = page.render(
                    scale=scale,
                    rotation=(int(rotation) % 360) // 90,
                    draw_annots=True,
                    may_draw_forms=True,
                )
            except TypeError:
                bitmap = page.render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
        try:
            page.close()
        except Exception:
            pass
        return image
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def _looks_blank(image: Image.Image) -> bool:
    tiny = image.convert("L").resize((32, 32))
    extrema = tiny.getextrema()
    if not extrema:
        return False
    lo, hi = extrema
    # Almost all white with almost no contrast.
    return lo > 245 and hi > 250 and (hi - lo) < 8


def _hex_to_rgba(value: str | None, alpha: int = 255) -> tuple[int, int, int, int]:
    if not value:
        return 0, 0, 0, alpha
    value = value.strip()
    if value.startswith("rgba"):
        nums = re.findall(r"[\d.]+", value)
        if len(nums) >= 3:
            a = float(nums[3]) if len(nums) >= 4 else 1.0
            return int(float(nums[0])), int(float(nums[1])), int(float(nums[2])), int(max(0, min(1, a)) * 255)
    if value.startswith("rgb"):
        nums = re.findall(r"[\d.]+", value)
        if len(nums) >= 3:
            return int(float(nums[0])), int(float(nums[1])), int(float(nums[2])), alpha
    value = value.lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if len(value) == 6:
        try:
            return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha
        except ValueError:
            pass
    return 0, 0, 0, alpha



def _int_color_to_hex(value: Any) -> str:
    """Convert PyMuPDF integer colors to CSS #RRGGBB."""
    try:
        iv = int(value)
        return f"#{(iv >> 16) & 255:02x}{(iv >> 8) & 255:02x}{iv & 255:02x}"
    except Exception:
        return "#111111"


def _font_style_from_name(font_name: str | None, flags: int | None = None) -> tuple[bool, bool]:
    name = (font_name or "").lower()
    flag_val = int(flags or 0)
    bold = any(tok in name for tok in ["bold", "black", "heavy", "demi", "semibold"]) or bool(flag_val & 16)
    italic = any(tok in name for tok in ["italic", "oblique"]) or bool(flag_val & 2)
    return bold, italic

def _find_font(font_family: str | None = None, bold: bool = False, italic: bool = False) -> str | None:
    candidates: list[Path] = []
    win = Path("C:/Windows/Fonts")
    ff = (font_family or "arial").lower().replace("-", " ")
    if "+" in ff:
        ff = ff.split("+")[-1]
    ff_compact = ff.replace(" ", "")

    if win.exists():
        # Windows font file names for common fonts used by invoices/hotel folios.
        families: list[tuple[str, dict[str, str]]] = [
            ("calibri", {"regular": "calibri.ttf", "bold": "calibrib.ttf", "italic": "calibrii.ttf", "bolditalic": "calibriz.ttf"}),
            ("cambria", {"regular": "cambria.ttc", "bold": "cambriab.ttf", "italic": "cambriai.ttf", "bolditalic": "cambriaz.ttf"}),
            ("times", {"regular": "times.ttf", "bold": "timesbd.ttf", "italic": "timesi.ttf", "bolditalic": "timesbi.ttf"}),
            ("courier", {"regular": "cour.ttf", "bold": "courbd.ttf", "italic": "couri.ttf", "bolditalic": "courbi.ttf"}),
            ("georgia", {"regular": "georgia.ttf", "bold": "georgiab.ttf", "italic": "georgiai.ttf", "bolditalic": "georgiaz.ttf"}),
            ("verdana", {"regular": "verdana.ttf", "bold": "verdanab.ttf", "italic": "verdanai.ttf", "bolditalic": "verdanaz.ttf"}),
            ("tahoma", {"regular": "tahoma.ttf", "bold": "tahomabd.ttf", "italic": "tahoma.ttf", "bolditalic": "tahomabd.ttf"}),
            ("segoe", {"regular": "segoeui.ttf", "bold": "segoeuib.ttf", "italic": "segoeuii.ttf", "bolditalic": "segoeuiz.ttf"}),
            ("arial", {"regular": "arial.ttf", "bold": "arialbd.ttf", "italic": "ariali.ttf", "bolditalic": "arialbi.ttf"}),
            ("helvetica", {"regular": "arial.ttf", "bold": "arialbd.ttf", "italic": "ariali.ttf", "bolditalic": "arialbi.ttf"}),
        ]
        style_key = "bolditalic" if bold and italic else "bold" if bold else "italic" if italic else "regular"
        for token, files in families:
            if token in ff or token in ff_compact:
                candidates.append(win / files.get(style_key, files["regular"]))
                candidates.append(win / files["regular"])
                break
        # Always have Arial/Segoe fallbacks.
        if italic and bold:
            candidates.append(win / "arialbi.ttf")
        elif italic:
            candidates.append(win / "ariali.ttf")
        elif bold:
            candidates.append(win / "arialbd.ttf")
        candidates += [win / "arial.ttf", win / "segoeui.ttf"]

    mono = "mono" in ff or "courier" in ff or "consolas" in ff or "mono" in ff_compact
    serif = "times" in ff or "serif" in ff or "roman" in ff or "georgia" in ff or "cambria" in ff or "serif" in ff_compact or "roman" in ff_compact
    if mono:
        candidates += [
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-BoldOblique.ttf") if bold and italic else Path("/nope"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Oblique.ttf") if italic else Path("/nope"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf") if bold else Path("/nope"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
        ]
    elif serif:
        candidates += [
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf") if bold and italic else Path("/nope"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf") if italic else Path("/nope"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf") if bold else Path("/nope"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"),
        ]
    candidates += [
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf") if bold and italic else Path("/nope"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf") if italic else Path("/nope"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf") if bold else Path("/nope"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/Library/Fonts/Arial.ttf"),
    ]
    for cand in candidates:
        if cand.exists():
            return str(cand)
    return None


def _font(size: int, family: str | None = None, bold: bool = False, italic: bool = False) -> ImageFont.ImageFont:
    path = _find_font(family, bold, italic)
    if path:
        try:
            return ImageFont.truetype(path, max(1, int(size)))
        except Exception:
            pass
    return ImageFont.load_default()


def _text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, letter_spacing: float = 0.0) -> float:
    if not text:
        return 0.0
    bbox = draw.textbbox((0, 0), text, font=font)
    width = float(bbox[2] - bbox[0])
    if letter_spacing and len(text) > 1:
        width += float(letter_spacing) * (len(text) - 1)
    return width


def _draw_text_line(
    draw: ImageDraw.ImageDraw,
    xy: tuple[float, float],
    text: str,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int, int],
    letter_spacing: float = 0.0,
) -> None:
    x, y = xy
    if not letter_spacing:
        draw.text((x, y), text, font=font, fill=fill)
        return
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        bbox = draw.textbbox((0, 0), ch, font=font)
        x += (bbox[2] - bbox[0]) + letter_spacing


def _draw_wrapped_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[float, float],
    text: str,
    max_width: float,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int, int],
    line_spacing: float = 1.2,
    align: str = "left",
    letter_spacing: float = 0.0,
) -> None:
    x, y = xy
    lines: list[str] = []
    for raw_line in (text or "").splitlines() or [""]:
        words = raw_line.split(" ")
        line = ""
        for word in words:
            test = word if not line else f"{line} {word}"
            if _text_width(draw, test, font, letter_spacing) <= max_width or not line:
                line = test
            else:
                lines.append(line)
                line = word
        lines.append(line)
    try:
        sample_bbox = draw.textbbox((0, 0), "Ag", font=font)
        line_h = max(1, (sample_bbox[3] - sample_bbox[1]) * line_spacing)
    except Exception:
        line_h = 14 * line_spacing
    yy = y
    for line in lines:
        line_w = _text_width(draw, line, font, letter_spacing)
        xx = x
        if align == "center":
            xx = x + max(0, (max_width - line_w) / 2)
        elif align == "right":
            xx = x + max(0, max_width - line_w)
        _draw_text_line(draw, (xx, yy), line, font, fill, letter_spacing)
        yy += line_h


def _data_url_to_image(data_url: str) -> Image.Image | None:
    try:
        if "," in data_url:
            data_url = data_url.split(",", 1)[1]
        raw = base64.b64decode(data_url)
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        return None


def _composite_annotations(image: Image.Image, page_payload: dict[str, Any]) -> Image.Image:
    base_w = float(page_payload.get("baseWidth") or image.width)
    base_h = float(page_payload.get("baseHeight") or image.height)
    sx = image.width / max(1.0, base_w)
    sy = image.height / max(1.0, base_h)
    layer = image.convert("RGBA")
    draw = ImageDraw.Draw(layer, "RGBA")

    def px(v: Any, axis: str = "x") -> float:
        scale = sx if axis == "x" else sy
        try:
            return float(v) * scale
        except Exception:
            return 0.0

    for ann in page_payload.get("annotations", []) or []:
        if ann.get("hidden"):
            continue
        typ = ann.get("type")
        if typ == "edit_text_erase":
            continue
        x = px(ann.get("x", 0), "x")
        y = px(ann.get("y", 0), "y")
        w = px(ann.get("w", 0), "x")
        h = px(ann.get("h", 0), "y")
        if typ in {"whiteout", "edit_whiteout"}:
            draw.rectangle([x, y, x + w, y + h], fill=_hex_to_rgba(ann.get("color") or "#ffffff", 255))
        elif typ == "redact":
            draw.rectangle([x, y, x + w, y + h], fill=(0, 0, 0, 255))
        elif typ in {"highlight", "text_highlight"}:
            color = _hex_to_rgba(ann.get("color") or "#ffeb3b", 95)
            draw.rectangle([x, y, x + w, y + h], fill=color)
        elif typ in {"draw", "sign"}:
            pts = ann.get("points") or []
            if len(pts) >= 2:
                color = _hex_to_rgba(ann.get("color") or "#111111", 255)
                width = max(1, int(float(ann.get("strokeWidth") or 3) * sx))
                scaled = [(px(p.get("x", 0), "x"), px(p.get("y", 0), "y")) for p in pts]
                draw.line(scaled, fill=color, width=width, joint="curve")
        elif typ == "line":
            color = _hex_to_rgba(ann.get("color") or "#111111", 255)
            width = max(1, int(float(ann.get("strokeWidth") or 2) * sx))
            x1 = px(ann.get("x1", ann.get("x", 0)), "x")
            y1 = px(ann.get("y1", ann.get("y", 0)), "y")
            x2 = px(ann.get("x2", float(ann.get("x", 0)) + float(ann.get("w", 0))), "x")
            y2 = px(ann.get("y2", float(ann.get("y", 0)) + float(ann.get("h", 0))), "y")
            draw.line([x1, y1, x2, y2], fill=color, width=width)
        elif typ == "image":
            img = _data_url_to_image(ann.get("dataUrl") or "")
            if img is not None and w > 1 and h > 1:
                resized = img.resize((max(1, int(w)), max(1, int(h))))
                layer.alpha_composite(resized, (int(x), int(y)))
        elif typ in {"text", "edit_text", "stamp", "note", "link"}:
            text = str(ann.get("text") or "")
            if typ == "stamp":
                border = _hex_to_rgba(ann.get("color") or "#d10000", 255)
                draw.rounded_rectangle([x, y, x + w, y + h], radius=max(2, int(8 * sx)), outline=border, width=max(2, int(2 * sx)))
                fill = border
                fnt = _font(int(float(ann.get("fontSize") or 28) * sx), ann.get("fontFamily"), True, False)
                _draw_wrapped_text(draw, (x + 8 * sx, y + 8 * sy), text, max(1, w - 16 * sx), fnt, fill, align="center")
            elif typ == "note":
                draw.rounded_rectangle([x, y, x + w, y + h], radius=max(2, int(6 * sx)), fill=(255, 249, 170, 235), outline=(210, 180, 50, 255), width=max(1, int(1 * sx)))
                fnt = _font(int(float(ann.get("fontSize") or 14) * sx), ann.get("fontFamily"), False, False)
                fill = _hex_to_rgba(ann.get("color") or "#232323", 255)
                _draw_wrapped_text(draw, (x + 8 * sx, y + 8 * sy), text, max(1, w - 16 * sx), fnt, fill, align=ann.get("align") or "left")
            elif typ == "link":
                fnt = _font(int(float(ann.get("fontSize") or 14) * sx), ann.get("fontFamily"), False, False)
                fill = _hex_to_rgba(ann.get("color") or "#0645ad", 255)
                _draw_wrapped_text(draw, (x, y), text or ann.get("href") or "Link", max(1, w), fnt, fill)
                draw.line([x, y + h - 2 * sy, x + w, y + h - 2 * sy], fill=fill, width=max(1, int(sx)))
            else:
                size = int(float(ann.get("fontSize") or 18) * sx)
                fnt = _font(size, ann.get("fontFamily"), bool(ann.get("bold")), bool(ann.get("italic")))
                fill = _hex_to_rgba(ann.get("color") or "#111111", 255)
                letter_spacing = float(ann.get("letterSpacing") or 0) * sx
                line_height = float(ann.get("lineHeight") or (1.0 if typ == "edit_text" else 1.2))
                _draw_wrapped_text(draw, (x, y), text, max(1, w or 300 * sx), fnt, fill, line_spacing=line_height, align=ann.get("align") or "left", letter_spacing=letter_spacing)
    return layer.convert("RGB")


def _erase_rects_for_page(page_payload: dict[str, Any]) -> list[dict[str, float]]:
    """Return source-page rectangles where only original PDF text should be removed.

    For clicked text we use the original PyMuPDF span bbox (`sourceBox`), so the
    redaction removes text glyphs but leaves images, watermark and line art. For
    manually drawn edit boxes, the rectangle is already in the current page
    coordinate system and works best when the page is not rotated.
    """
    rects: list[dict[str, float]] = []
    for ann in page_payload.get("annotations", []) or []:
        typ = ann.get("type")
        if typ == "edit_text" and ann.get("eraseMode") == "text":
            box = ann.get("sourceBox") or ann
        elif typ == "edit_text_erase":
            box = ann
        else:
            continue
        try:
            x = float(box.get("x", 0))
            y = float(box.get("y", 0))
            w = float(box.get("w", 0))
            h = float(box.get("h", 0))
        except Exception:
            continue
        if w <= 0.5 or h <= 0.5:
            continue
        # A very small padding catches antialiasing edges without touching nearby table lines.
        pad_x = min(0.8, max(0.15, w * 0.01))
        pad_y = min(0.6, max(0.10, h * 0.02))
        rects.append({"x": x - pad_x, "y": y - pad_y, "w": w + 2 * pad_x, "h": h + 2 * pad_y})
    return rects


def _render_export_background(path: Path, page_payload: dict[str, Any], scale: float, rotation: int) -> Image.Image:
    source_page = int(page_payload.get("sourcePage") or page_payload.get("page") or 1)
    erase_rects = _erase_rects_for_page(page_payload)

    if erase_rects and fitz is not None:
        tmp_path = EXPORT_DIR / f"_text-removed-{uuid.uuid4().hex}.pdf"
        try:
            doc = fitz.open(str(path))
            page = doc[source_page - 1]
            for r in erase_rects:
                rect = fitz.Rect(r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"])
                page.add_redact_annot(rect, fill=None, cross_out=False)
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                text=fitz.PDF_REDACT_TEXT_REMOVE,
            )
            doc.save(str(tmp_path), garbage=4, deflate=True)
            doc.close()
            return _render_pdfium_page(tmp_path, source_page, scale=scale, rotation=rotation)
        except Exception:
            try:
                doc.close()  # type: ignore[name-defined]
            except Exception:
                pass
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

    return _render_pdfium_page(path, source_page, scale=scale, rotation=rotation)


def _norm_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _extract_text_pymupdf(path: Path, page_number: int) -> tuple[list[dict[str, Any]], str]:
    """Extract visual text spans with top-left PDF coordinates plus font/color style."""
    if fitz is None:
        return [], "pymupdf-missing"
    doc = fitz.open(str(path))
    try:
        if page_number < 1 or page_number > doc.page_count:
            raise HTTPException(status_code=404, detail="Trang không tồn tại")
        page = doc[page_number - 1]

        # Prefer span extraction because it preserves font name, size, color, bold/italic.
        items: list[dict[str, Any]] = []
        try:
            data = page.get_text("dict") or {}
            span_index = 0
            for block_no, block in enumerate(data.get("blocks", []) or []):
                if block.get("type") != 0:
                    continue
                for line_no, line in enumerate(block.get("lines", []) or []):
                    for span_no, span in enumerate(line.get("spans", []) or []):
                        text = _norm_text(str(span.get("text") or ""))
                        if not text:
                            continue
                        x0, y0, x1, y1 = [float(v) for v in span.get("bbox", (0, 0, 0, 0))]
                        font_name = str(span.get("font") or "")
                        flags = int(span.get("flags") or 0)
                        span_bold, span_italic = _font_style_from_name(font_name, flags)
                        size = float(span.get("size") or max(1.0, y1 - y0))
                        items.append(
                            {
                                "id": f"mupdf-span-{block_no}-{line_no}-{span_no}-{span_index}",
                                "text": text,
                                "x": x0,
                                "y": y0,
                                "w": max(1.0, x1 - x0),
                                "h": max(1.0, y1 - y0),
                                "block": block_no,
                                "line": line_no,
                                "span": span_no,
                                "source": "PyMuPDF",
                                "fontFamily": font_name or "Arial",
                                "fontSize": size,
                                "color": _int_color_to_hex(span.get("color", 0x111111)),
                                "bold": span_bold,
                                "italic": span_italic,
                            }
                        )
                        span_index += 1
        except Exception:
            items = []

        if items:
            items.sort(key=lambda it: (it["y"], it["x"]))
            return items, "pymupdf"

        # Fallback: word grouping without style metadata.
        words = page.get_text("words") or []
        groups: dict[tuple[int, int], list[Any]] = {}
        for w in words:
            if len(w) < 8:
                continue
            text = _norm_text(str(w[4]))
            if not text:
                continue
            key = (int(w[5]), int(w[6]))
            groups.setdefault(key, []).append(w)

        for (block_no, line_no), line_words in groups.items():
            line_words = sorted(line_words, key=lambda x: (float(x[7]), float(x[0])))
            text = _norm_text(" ".join(str(w[4]) for w in line_words))
            if not text:
                continue
            x0 = min(float(w[0]) for w in line_words)
            y0 = min(float(w[1]) for w in line_words)
            x1 = max(float(w[2]) for w in line_words)
            y1 = max(float(w[3]) for w in line_words)
            items.append(
                {
                    "id": f"mupdf-{block_no}-{line_no}",
                    "text": text,
                    "x": x0,
                    "y": y0,
                    "w": max(1.0, x1 - x0),
                    "h": max(1.0, y1 - y0),
                    "block": block_no,
                    "line": line_no,
                    "source": "PyMuPDF",
                    "fontFamily": "Arial",
                    "fontSize": max(6.0, y1 - y0),
                    "color": "#111111",
                    "bold": False,
                    "italic": False,
                }
            )
        items.sort(key=lambda it: (it["y"], it["x"]))
        return items, "pymupdf"
    finally:
        doc.close()


def _extract_text_pdfium(path: Path, page_number: int) -> tuple[list[dict[str, Any]], str]:
    """Fallback text extraction with PDFium. Returns line boxes in top-left coordinates."""
    if pdfium is None:
        return [], "pdfium-missing"
    pdf = _open_pdf(path)
    try:
        if page_number < 1 or page_number > len(pdf):
            raise HTTPException(status_code=404, detail="Trang không tồn tại")
        page = pdf[page_number - 1]
        page_w, page_h = _page_size(page)
        textpage = page.get_textpage()
        chars: list[dict[str, Any]] = []
        try:
            count = int(textpage.count_chars())
            for i in range(count):
                ch = textpage.get_text_range(i, 1, errors="ignore") or ""
                if not ch or ch in "\r\n\t":
                    continue
                try:
                    left, bottom, right, top = textpage.get_charbox(i, loose=True)
                except TypeError:
                    left, bottom, right, top = textpage.get_charbox(i)
                x = float(left)
                y = float(page_h - top)
                w = max(0.1, float(right - left))
                h = max(0.1, float(top - bottom))
                chars.append({"text": ch, "x": x, "y": y, "w": w, "h": h, "cx": x + w / 2, "cy": y + h / 2})
        finally:
            try:
                textpage.close()
            except Exception:
                pass
            try:
                page.close()
            except Exception:
                pass

        if not chars:
            return [], "pdfium"

        # Group chars into visual lines by y proximity, then compact each line into a box.
        chars.sort(key=lambda c: (c["cy"], c["x"]))
        lines: list[list[dict[str, Any]]] = []
        for ch in chars:
            placed = False
            for line in lines:
                avg_y = sum(c["cy"] for c in line) / len(line)
                avg_h = max(1.0, sum(c["h"] for c in line) / len(line))
                if abs(ch["cy"] - avg_y) <= max(2.5, avg_h * 0.45):
                    line.append(ch)
                    placed = True
                    break
            if not placed:
                lines.append([ch])

        items: list[dict[str, Any]] = []
        for idx, line in enumerate(lines):
            line = sorted(line, key=lambda c: c["x"])
            raw = "".join(c["text"] for c in line)
            text = _norm_text(raw)
            if not text:
                continue
            x0 = min(c["x"] for c in line)
            y0 = min(c["y"] for c in line)
            x1 = max(c["x"] + c["w"] for c in line)
            y1 = max(c["y"] + c["h"] for c in line)
            items.append({"id": f"pdfium-{idx}", "text": text, "x": x0, "y": y0, "w": max(1.0, x1 - x0), "h": max(1.0, y1 - y0), "source": "PDFium", "fontFamily": "Arial", "fontSize": max(6.0, y1 - y0), "color": "#111111", "bold": False, "italic": False})
        items.sort(key=lambda it: (it["y"], it["x"]))
        return items, "pdfium"
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def _extract_page_text_items(path: Path, page_number: int) -> tuple[list[dict[str, Any]], str]:
    items, engine = _extract_text_pymupdf(path, page_number)
    if items:
        return items, engine
    return _extract_text_pdfium(path, page_number)


@app.get("/api/text/{doc_id}/{page_number}")
def text_layer(doc_id: str, page_number: int) -> JSONResponse:
    path = _doc_path(doc_id)
    items, engine = _extract_page_text_items(path, page_number)
    text = "\n".join(item["text"] for item in items)
    return JSONResponse({"page": page_number, "engine": engine, "hasText": bool(items), "items": items, "text": text})


@app.get("/api/search/{doc_id}")
def search_text(doc_id: str, q: str) -> JSONResponse:
    path = _doc_path(doc_id)
    query = _norm_text(q).lower()
    if not query:
        return JSONResponse({"results": []})
    pdf = _open_pdf(path)
    page_count = len(pdf)
    try:
        pdf.close()
    except Exception:
        pass
    results = []
    for page_number in range(1, page_count + 1):
        items, engine = _extract_page_text_items(path, page_number)
        joined = " ".join(item["text"] for item in items)
        idx = joined.lower().find(query)
        if idx >= 0:
            results.append({
                "page": page_number,
                "engine": engine,
                "snippet": joined[max(0, idx - 70): idx + len(query) + 100],
                "matches": [item for item in items if query in item["text"].lower()][:20],
            })
    return JSONResponse({"results": results})


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "pdfium": pdfium is not None, "pymupdf": fitz is not None}


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)) -> JSONResponse:
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Chỉ nhận file .pdf")
    doc_id = str(uuid.uuid4())
    out = UPLOAD_DIR / f"{doc_id}.pdf"
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="File rỗng")
    out.write_bytes(content)

    pdf = _open_pdf(out)
    pages = []
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            w, h = _page_size(page)
            pages.append({"page": i + 1, "width": w, "height": h})
            try:
                page.close()
            except Exception:
                pass
    finally:
        try:
            pdf.close()
        except Exception:
            pass

    return JSONResponse(
        {
            "docId": doc_id,
            "fileName": file.filename,
            "safeName": _safe_name(file.filename),
            "pageCount": len(pages),
            "pages": pages,
            "renderEngine": "PDFium/pypdfium2",
        }
    )


@app.post("/api/render_clean")
async def render_clean(request: Request) -> StreamingResponse:
    """Render one page after deleting selected original text, without painting a white box.

    Used for live preview of Edit text: PyMuPDF removes only text glyphs in
    the edit rectangles while keeping images, watermark and line art. PDFium
    then renders that cleaned page to PNG.
    """
    payload = await request.json()
    doc_id = payload.get("docId")
    if not doc_id:
        raise HTTPException(status_code=400, detail="Thiếu docId")
    path = _doc_path(doc_id)
    page_number = int(payload.get("page") or 1)
    scale = max(0.2, min(float(payload.get("scale") or 1.5), 4.0))
    rotation = int(payload.get("rotation") or 0)
    page_payload = payload.get("pagePayload") or {}
    page_payload.setdefault("sourcePage", page_number)
    page_payload.setdefault("rotation", rotation)
    image = _render_export_background(path, page_payload, scale=scale, rotation=rotation)
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    headers = {"X-Looks-Blank": "1" if _looks_blank(image) else "0"}
    return StreamingResponse(buf, media_type="image/png", headers=headers)


@app.get("/api/render/{doc_id}/{page_number}")
def render_page(doc_id: str, page_number: int, scale: float = 1.5, rotation: int = 0) -> StreamingResponse:
    path = _doc_path(doc_id)
    scale = max(0.2, min(float(scale), 4.0))
    image = _render_pdfium_page(path, page_number, scale=scale, rotation=rotation)
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    headers = {"X-Looks-Blank": "1" if _looks_blank(image) else "0"}
    return StreamingResponse(buf, media_type="image/png", headers=headers)




def _hex_to_rgb01(value: str | None) -> tuple[float, float, float]:
    r, g, b, _ = _hex_to_rgba(value, 255)
    return max(0, min(1, r / 255)), max(0, min(1, g / 255)), max(0, min(1, b / 255))


def _align_value(value: str | None) -> int:
    if value == "center":
        return 1
    if value == "right":
        return 2
    return 0


def _rect_from_ann(ann: dict[str, Any]) -> "fitz.Rect":
    return fitz.Rect(
        float(ann.get("x") or 0),
        float(ann.get("y") or 0),
        float(ann.get("x") or 0) + float(ann.get("w") or 0),
        float(ann.get("y") or 0) + float(ann.get("h") or 0),
    )


def _font_for_pymupdf(font_family: str | None, bold: bool = False, italic: bool = False) -> tuple[str, str | None]:
    """Return a Base14 font name and optionally a TrueType file.

    On Windows this picks real C:\\Windows\\Fonts files, so edited invoice text
    can visually match Times/Arial/Calibri much better. If no font file exists,
    PyMuPDF falls back to Base14 fonts.
    """
    ff = (font_family or "Arial").lower()
    font_file = _find_font(font_family, bold, italic)
    if font_file:
        # Use a stable but unique resource name. PyMuPDF embeds the fontfile.
        compact = re.sub(r"[^A-Za-z0-9]", "", font_family or "Custom")[:18] or "Custom"
        style = ("B" if bold else "") + ("I" if italic else "")
        return f"/{compact}{style}", font_file
    if "cour" in ff or "mono" in ff:
        return ("cobi" if bold and italic else "coit" if italic else "cobo" if bold else "cour"), None
    if "times" in ff or "roman" in ff or "serif" in ff or "cambria" in ff or "georgia" in ff:
        return ("tibi" if bold and italic else "tiit" if italic else "tibo" if bold else "tiro"), None
    return ("hebi" if bold and italic else "heit" if italic else "hebo" if bold else "helv"), None


def _draw_vector_text(page: Any, ann: dict[str, Any]) -> None:
    text = str(ann.get("text") or "")
    if not text:
        return
    rect = _rect_from_ann(ann)
    if rect.width <= 0 or rect.height <= 0:
        return
    fontsize = max(1.0, float(ann.get("fontSize") or 12))
    color = _hex_to_rgb01(ann.get("color") or "#111111")
    align = _align_value(ann.get("align"))
    bold = bool(ann.get("bold"))
    italic = bool(ann.get("italic"))
    fontname, fontfile = _font_for_pymupdf(ann.get("fontFamily"), bold, italic)
    lineheight = float(ann.get("lineHeight") or 1.0) or 1.0
    # Give a tiny vertical adjustment because PyMuPDF bbox top and browser text top differ slightly.
    def _insert_at_baseline(use_fontname: str, use_fontfile: str | None = None) -> None:
        lines = text.splitlines() or [text]
        lh = max(fontsize * 0.9, fontsize * lineheight)
        for i, line in enumerate(lines):
            if not line:
                continue
            # PyMuPDF insert_text expects a baseline point, not a top-left point.
            baseline_y = rect.y0 + fontsize * 0.86 + i * lh
            baseline_x = rect.x0
            if align in {1, 2}:
                try:
                    tw = fitz.get_text_length(line, fontname=use_fontname if not use_fontfile else "helv", fontsize=fontsize)
                except Exception:
                    tw = 0
                if align == 1:
                    baseline_x = rect.x0 + max(0, (rect.width - tw) / 2)
                elif align == 2:
                    baseline_x = rect.x1 - tw
            page.insert_text((baseline_x, baseline_y), line, fontname=use_fontname, fontfile=use_fontfile, fontsize=fontsize, color=color, overlay=True)

    try:
        remaining = page.insert_textbox(
            rect,
            text,
            fontname=fontname,
            fontfile=fontfile,
            fontsize=fontsize,
            lineheight=lineheight,
            color=color,
            align=align,
            overlay=True,
        )
        if isinstance(remaining, (int, float)) and remaining < 0:
            _insert_at_baseline(fontname, fontfile)
    except Exception:
        # Fallback with Base14 font if embedding fails.
        fallback = "tibo" if bold and ("times" in str(ann.get("fontFamily") or "").lower()) else "helv"
        try:
            remaining = page.insert_textbox(rect, text, fontname=fallback, fontsize=fontsize, lineheight=lineheight, color=color, align=align, overlay=True)
            if isinstance(remaining, (int, float)) and remaining < 0:
                _insert_at_baseline(fallback, None)
        except Exception:
            try:
                _insert_at_baseline(fallback, None)
            except Exception:
                pass


def _draw_vector_image(page: Any, ann: dict[str, Any]) -> None:
    data_url = ann.get("dataUrl") or ""
    if not data_url:
        return
    try:
        raw = data_url.split(",", 1)[1] if "," in data_url else data_url
        img_bytes = base64.b64decode(raw)
        page.insert_image(_rect_from_ann(ann), stream=img_bytes, overlay=True, keep_proportion=False)
    except Exception:
        pass


def _apply_vector_annotations(page: Any, page_payload: dict[str, Any]) -> None:
    """Apply non-destructive vector edits directly on the PDF page.

    Key point: edit_text uses a redaction annotation with fill=None and
    apply_redactions(images=NONE, graphics=NONE, text=REMOVE). That deletes only
    text glyphs inside the rectangle. Images, watermark, line art and background
    remain untouched.
    """
    anns = page_payload.get("annotations", []) or []

    # 1) Remove old PDF text only, without filling a white rectangle.
    has_redactions = False
    for ann in anns:
        typ = ann.get("type")
        if typ == "edit_text" and ann.get("eraseMode") == "text":
            box = ann.get("sourceBox") or ann
        elif typ == "edit_text_erase":
            box = ann
        else:
            continue
        try:
            rect = fitz.Rect(float(box.get("x", 0)), float(box.get("y", 0)), float(box.get("x", 0)) + float(box.get("w", 0)), float(box.get("y", 0)) + float(box.get("h", 0)))
            if rect.width > 0.2 and rect.height > 0.2:
                # Transparent redaction: delete text, do not paint anything.
                page.add_redact_annot(rect, fill=None, cross_out=False)
                has_redactions = True
        except Exception:
            continue
    if has_redactions:
        try:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE, text=fitz.PDF_REDACT_TEXT_REMOVE)
        except Exception:
            page.apply_redactions(images=0, graphics=0, text=0)

    # 2) Draw added objects. Keep edit_text after redaction so it sits on top.
    for ann in anns:
        if ann.get("hidden"):
            continue
        typ = ann.get("type")
        if typ in {"edit_text_erase"}:
            continue
        try:
            rect = _rect_from_ann(ann)
        except Exception:
            continue
        if rect.width <= 0 or rect.height <= 0:
            continue
        color = _hex_to_rgb01(ann.get("color") or "#111111")
        if typ in {"whiteout", "edit_whiteout"}:
            page.draw_rect(rect, color=None, fill=_hex_to_rgb01(ann.get("color") or "#ffffff"), overlay=True)
        elif typ == "redact":
            page.draw_rect(rect, color=None, fill=(0, 0, 0), overlay=True)
        elif typ in {"highlight", "text_highlight"}:
            page.draw_rect(rect, color=None, fill=_hex_to_rgb01(ann.get("color") or "#ffeb3b"), fill_opacity=0.35, overlay=True)
        elif typ == "line":
            x1 = float(ann.get("x1", ann.get("x", 0)))
            y1 = float(ann.get("y1", ann.get("y", 0)))
            x2 = float(ann.get("x2", float(ann.get("x", 0)) + float(ann.get("w", 0))))
            y2 = float(ann.get("y2", float(ann.get("y", 0)) + float(ann.get("h", 0))))
            page.draw_line((x1, y1), (x2, y2), color=color, width=max(0.5, float(ann.get("strokeWidth") or 2)), overlay=True)
        elif typ in {"draw", "sign"}:
            pts = ann.get("points") or []
            if len(pts) >= 2:
                for a, b in zip(pts[:-1], pts[1:]):
                    page.draw_line((float(a.get("x", 0)), float(a.get("y", 0))), (float(b.get("x", 0)), float(b.get("y", 0))), color=color, width=max(0.5, float(ann.get("strokeWidth") or (3 if typ == "sign" else 2))), overlay=True)
        elif typ == "image":
            _draw_vector_image(page, ann)
        elif typ in {"text", "edit_text", "note", "link"}:
            _draw_vector_text(page, ann)
        elif typ == "stamp":
            page.draw_rect(rect, color=color, width=1.4, overlay=True)
            stamp_ann = dict(ann)
            stamp_ann.setdefault("fontSize", 26)
            stamp_ann["bold"] = True
            _draw_vector_text(page, stamp_ann)


def _export_pdf_native(path: Path, payload: dict[str, Any], pages: list[dict[str, Any]]) -> Path:
    if fitz is None:
        raise RuntimeError("Thiếu PyMuPDF để export native")
    src_doc = fitz.open(str(path))
    out_doc = fitz.open()
    try:
        for page_payload in pages:
            if page_payload.get("deleted"):
                continue
            source_page = int(page_payload.get("sourcePage") or page_payload.get("page") or 1)
            if source_page < 1 or source_page > src_doc.page_count:
                continue
            out_doc.insert_pdf(src_doc, from_page=source_page - 1, to_page=source_page - 1)
            page = out_doc[-1]
            _apply_vector_annotations(page, page_payload)
            rotation = int(page_payload.get("rotation") or 0)
            if rotation:
                page.set_rotation((page.rotation + rotation) % 360)
        if out_doc.page_count == 0:
            raise HTTPException(status_code=400, detail="Tất cả trang đã bị xóa")
        name = _safe_name(payload.get("fileName") or "edited")
        export_id = str(uuid.uuid4())
        export_path = EXPORT_DIR / f"{name}-native-{export_id[:8]}.pdf"
        out_doc.save(str(export_path), garbage=4, deflate=True, clean=True)
        return export_path
    finally:
        out_doc.close()
        src_doc.close()


@app.post("/api/export")
async def export_pdf(request: Request) -> FileResponse:
    payload = await request.json()
    doc_id = payload.get("docId")
    if not doc_id:
        raise HTTPException(status_code=400, detail="Thiếu docId")
    path = _doc_path(doc_id)
    scale = max(1.0, min(float(payload.get("scale") or 2.0), 3.0))
    pages = payload.get("pages") or []
    if not pages:
        raise HTTPException(status_code=400, detail="Không có trang để xuất")

    name = _safe_name(payload.get("fileName") or "edited")
    export_mode = str(payload.get("exportMode") or "native").lower()

    if export_mode == "native":
        try:
            export_path = _export_pdf_native(path, payload, pages)
            return FileResponse(
                export_path,
                media_type="application/pdf",
                filename=f"{name}-edited-native.pdf",
            )
        except Exception as exc:
            # Native mode is preferred for text editing. If it fails, fall back to flatten
            # so the user still gets a PDF instead of losing edits.
            print(f"Native export failed, falling back to flatten: {exc}")

    output_images: list[Image.Image] = []
    for page_payload in pages:
        if page_payload.get("deleted"):
            continue
        source_page = int(page_payload.get("sourcePage") or page_payload.get("page") or 1)
        rotation = int(page_payload.get("rotation") or 0)
        try:
            bg = _render_export_background(path, page_payload, scale=scale, rotation=rotation)
        except Exception:
            bw = int(float(page_payload.get("baseWidth") or 595) * scale)
            bh = int(float(page_payload.get("baseHeight") or 842) * scale)
            bg = Image.new("RGB", (bw, bh), "white")
        output_images.append(_composite_annotations(bg, page_payload))

    if not output_images:
        raise HTTPException(status_code=400, detail="Tất cả trang đã bị xóa")

    export_id = str(uuid.uuid4())
    export_path = EXPORT_DIR / f"{name}-edited-{export_id[:8]}.pdf"
    first, rest = output_images[0], output_images[1:]
    first.save(
        export_path,
        "PDF",
        save_all=True,
        append_images=rest,
        resolution=72 * scale,
        quality=95,
    )
    return FileResponse(
        export_path,
        media_type="application/pdf",
        filename=f"{name}-edited.pdf",
    )
