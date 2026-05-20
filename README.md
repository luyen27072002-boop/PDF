# Local PDF Editor - Native Text giống PDFAid

Dự án này là một tool sửa PDF chạy local trên máy của bạn.

Nó có giao diện web giống các tool online kiểu PDFAid: upload PDF, xem thumbnail, chọn công cụ, sửa trực tiếp trên trang, truy cập text layer nếu PDF có chữ thật, rồi xuất ra PDF mới.

## Vì sao bản này mở được file đang bị trắng?

Bản này không dùng PyMuPDF để preview nữa. Preview mặc định dùng **PDFium qua pypdfium2** ở backend, gần với engine render PDF của Chrome hơn, nên xử lý tốt hơn với nhiều file form/hotel folio/invoice bị trắng khi render bằng PyMuPDF.

Ngoài ra UI có chế độ **PDF.js browser/XFA** trong thanh Render. Nếu PDFium vẫn ra trắng, đổi sang chế độ đó để thử.


## Bản text-style mới

Bản này cải thiện phần Edit text:

- Khi click vào chữ gốc, tool cố gắng lấy đúng font, cỡ chữ, màu chữ, đậm/nghiêng từ PDF gốc.
- Thanh format có thêm nhiều font: Helvetica, Calibri, Cambria, Georgia, Verdana, Tahoma, Segoe UI...
- Có chọn căn trái/giữa/phải.
- Có tùy chọn **Giữ kiểu chữ gốc**. Bật mặc định.
- Có chế độ **Xóa text, giữ nền**: khi xuất PDF, tool xóa glyph chữ cũ khỏi text layer nhưng giữ watermark, ảnh nền và đường kẻ. Nếu muốn kiểu cũ thì chọn **Che bằng màu nền**.

Lưu ý: xóa chữ cũ trong PDF vẫn phải phủ vùng chữ cũ bằng nền. Nếu phía dưới chữ có watermark, đường kẻ, ảnh, hoặc nền phức tạp thì việc phủ nền có thể che mất phần đó. Đây là giới hạn chung của chỉnh PDF theo dạng visual editor.

## Chức năng

- Upload PDF local
- Xem thumbnail từng trang
- Zoom
- Chuyển trang
- Xoay trang trái/phải
- Xóa/khôi phục trang
- Đổi thứ tự trang
- Add text
- Edit text có text layer: click trực tiếp vào chữ đã nhận diện để sửa, hoặc kéo vùng cũ rồi nhập chữ mới
- Nút Text để xem/copy toàn bộ text của trang hiện tại
- Search text bằng backend text layer, không phụ thuộc CDN PDF.js
- Sign/ký tay
- Line
- Draw
- Eraser xóa đối tượng vừa thêm
- Whiteout che trắng
- Redact che đen
- Highlight
- Text highlight
- Thêm ảnh
- Stamp
- Link dạng text/link visual
- Note/ghi chú
- Undo/redo
- Xuất PDF mới
- Print bản đã xuất

## Cách sửa text thật trong file

1. Upload PDF.
2. Chọn công cụ **Edit text** trên thanh toolbar.
3. Nếu PDF có text layer, các dòng chữ sẽ hiện khung xanh.
4. Click vào khung xanh của dòng chữ muốn sửa.
5. Tool tự tạo một lớp che chữ cũ và một ô text mới đúng vị trí đó.
6. Gõ nội dung mới, kéo/resize nếu cần, rồi bấm **Xuất PDF**.

Nếu không thấy khung xanh khi chọn **Edit text**, PDF đó nhiều khả năng là ảnh scan hoặc form đặc biệt không có text layer. Khi đó phải thêm OCR nếu muốn nhận diện chữ tự động; còn không thì vẫn sửa kiểu thủ công bằng cách kéo vùng che và nhập chữ mới.

## Lưu ý quan trọng

PDF không giống Word. Tool này có thể **truy cập text layer** nếu file PDF thật sự có text bên trong. Khi chọn `Edit text`, các dòng chữ nhận diện được sẽ hiện khung xanh; click vào khung đó để tạo lớp sửa chữ ngay đúng vị trí.

Bản export mặc định là **flatten PDF**: render trang gốc thành ảnh chất lượng cao, vẽ các chỉnh sửa lên trên, rồi đóng gói thành PDF mới. Cách này giữ đúng preview và xử lý được nhiều PDF khó render/form/XFA. Nhược điểm là chữ trong bản export có thể không còn searchable/editable như PDF gốc.

Nếu PDF là ảnh scan không có text layer, tool sẽ báo không có text. Muốn lấy chữ trong trường hợp đó cần thêm OCR như Tesseract/OCRmyPDF.

## Cách chạy trên Windows

Cách dễ nhất: bấm đúp `START_WINDOWS.bat`.

Hoặc mở PowerShell trong thư mục project:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
.\run.bat
```

Mở trình duyệt:

```text
http://127.0.0.1:8000
```

Trong PowerShell phải chạy `.\run.bat`, không phải chỉ gõ `run.bat`.

## Cách chạy trên macOS/Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
./run.sh
```

Mở:

```text
http://127.0.0.1:8000
```

## Docker

```bash
docker build -t local-pdf-editor .
docker run --rm -p 8000:8000 local-pdf-editor
```

## Nếu vẫn bị trắng trang

1. Chọn Render -> `PDF.js browser/XFA`.
2. Bấm `Ctrl + F5` để reload sạch cache.
3. Mở PDF bằng Chrome hoặc Edge -> Print -> Save as PDF -> upload lại file vừa lưu. Cách này ép PDF về dạng phẳng dễ render hơn.

## Cấu trúc project

```text
pdfaid-like-editor/
  app/
    main.py              # FastAPI backend, upload/render/text-layer/search/export PDF
    static/
      index.html         # UI
      style.css          # CSS
      app.js             # Logic editor
  storage/
    uploads/             # PDF upload tạm thời
    exports/             # PDF export tạm thời
  tests/
  requirements.txt
  START_WINDOWS.bat
  run.bat
  run.sh
  Dockerfile
```

## Edit text không mất nền

Bản này có chế độ `Xóa text, giữ nền`. Khi sửa chữ, backend dùng PyMuPDF để xóa text glyph gốc trong đúng vùng đó, không tô ô trắng, nên watermark/đường kẻ/nền vẫn giữ lại. Bật `Preview sạch` để xem live preview sạch ngay trên web. Bật `Ẩn khung` để không hiện khung xanh khi đang nhập chữ mới.

Có thể chỉnh form chữ bằng các control trên thanh format: Font, Size, Giãn chữ, Line, Màu, B/I, Căn.


## Chế độ sửa chữ không mất nền

Bản này có chế độ **Native: xóa chữ giữ nền**. Khi dùng **Edit text**, phần export sẽ dùng PyMuPDF để xóa riêng glyph chữ cũ trong vùng đã chọn bằng transparent redaction, không tô ô trắng. Sau đó tool ghi chữ mới lên đúng vị trí, giữ lại watermark, đường kẻ, bảng và nền bên dưới.

Thiết lập nên dùng:

- `Xóa gốc`: `Xóa text, giữ nền`
- `Preview sạch`: bật
- `Ẩn khung`: bật
- `Xuất kiểu`: `Native: xóa chữ giữ nền`
- `Giữ kiểu chữ gốc`: bật nếu muốn lấy font/cỡ/màu từ chữ gốc

Có thể chỉnh `Font`, `Size`, `Giãn chữ`, `Line`, `Màu`, `B`, `I`, `Căn` trước hoặc sau khi click vào chữ cần sửa.

Lưu ý: PDF scan dạng ảnh không có text layer thì cần OCR trước khi sửa chữ thật.
