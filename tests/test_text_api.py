
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fitz
from fastapi.testclient import TestClient

from app.main import app


def make_pdf_bytes():
    doc = fitz.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((40, 60), "HELLO PDF TEXT", fontsize=14)
    data = doc.tobytes()
    doc.close()
    return data


def test_text_layer_endpoint_extracts_text():
    client = TestClient(app)
    res = client.post('/api/upload', files={'file': ('sample.pdf', make_pdf_bytes(), 'application/pdf')})
    assert res.status_code == 200, res.text
    doc_id = res.json()['docId']
    text_res = client.get(f'/api/text/{doc_id}/1')
    assert text_res.status_code == 200, text_res.text
    data = text_res.json()
    assert data['hasText'] is True
    assert 'HELLO PDF TEXT' in data['text']


def test_search_endpoint_finds_text():
    client = TestClient(app)
    res = client.post('/api/upload', files={'file': ('sample.pdf', make_pdf_bytes(), 'application/pdf')})
    doc_id = res.json()['docId']
    search_res = client.get(f'/api/search/{doc_id}', params={'q': 'PDF TEXT'})
    assert search_res.status_code == 200, search_res.text
    assert search_res.json()['results']
