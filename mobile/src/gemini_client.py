"""Shared Gemini REST client; no deprecated Google Python SDK required."""
import json
import os
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = "https://generativelanguage.googleapis.com/v1beta/"


def _request(path, payload=None):
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is missing from mobile/.env")
    req = Request(BASE + path, data=None if payload is None else json.dumps(payload).encode(),
                  headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urlopen(req, timeout=60) as response:
                return json.load(response)
        except HTTPError as exc:
            if exc.code in (429, 500, 503) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"Gemini HTTP {exc.code}; check GEMINI_MODEL, API key and AI Studio quota") from None


def available_models():
    models, page = [], "models?pageSize=1000"
    while page:
        data = _request(page)
        models.extend(m["name"].removeprefix("models/") for m in data.get("models", [])
                      if "generateContent" in m.get("supportedGenerationMethods", []))
        token = data.get("nextPageToken")
        from urllib.parse import quote
        page = "models?pageSize=1000&pageToken=" + quote(token) if token else None
    return models


def generate(prompt):
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").removeprefix("models/")
    data = _request(f"models/{model}:generateContent", {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
    })
    candidates = data.get("candidates") or []
    text = "".join(p.get("text", "") for p in (candidates[0].get("content", {}).get("parts", [])
                    if candidates else []) if not p.get("thought"))
    if not text:
        raise RuntimeError("Gemini returned no text; inspect model availability or safety restrictions")
    return text
