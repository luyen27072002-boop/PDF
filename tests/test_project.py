from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_required_files_exist():
    for rel in [
        'app/main.py',
        'app/static/index.html',
        'app/static/style.css',
        'app/static/app.js',
        'requirements.txt',
        'README.md',
        'run.bat',
    ]:
        assert (ROOT / rel).exists(), rel


def test_frontend_mentions_pdfium_and_xfa():
    html = (ROOT / 'app/static/index.html').read_text(encoding='utf-8')
    js = (ROOT / 'app/static/app.js').read_text(encoding='utf-8')
    assert 'PDFium backend' in html
    assert 'enableXfa' in js


def test_backend_has_upload_render_export_endpoints():
    code = (ROOT / 'app/main.py').read_text(encoding='utf-8')
    assert '@app.post("/api/upload")' in code
    assert '@app.get("/api/render/{doc_id}/{page_number}")' in code
    assert '@app.post("/api/export")' in code
