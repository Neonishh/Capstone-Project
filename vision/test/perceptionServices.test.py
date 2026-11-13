"""Offline service contracts: no model download or browser is used."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PerceptionTests(unittest.TestCase):
    def test_upscaled_ocr_boxes_return_to_original_coordinates(self):
        ocr = load("ocr_test", "vision/services/ocr-service/ocr.py")
        data = {"text": ["word", "noise"], "conf": ["94.5", "10"],
                "left": [40, 0], "top": [60, 0], "width": [80, 1], "height": [20, 1]}
        with patch.object(ocr.pytesseract, "image_to_data", return_value=data) as recognize:
            words = ocr.recognize_words(np.zeros((100, 200, 3), dtype=np.uint8), 2, "gray")
        self.assertEqual(recognize.call_args.args[0].shape, (200, 400))
        self.assertEqual(words, [{"text": "word", "conf": 94, "bbox": {"x": 20, "y": 30, "w": 40, "h": 10}}])

    def test_ocr_rejects_invalid_scaling_before_inference(self):
        ocr = load("ocr_invalid_test", "vision/services/ocr-service/ocr.py")
        img = np.zeros((20, 20, 3), dtype=np.uint8)
        for scale in [0, 4, float("nan")]:
            with self.assertRaises(ValueError):
                ocr.recognize_words(img, scale)
        with self.assertRaises(ValueError):
            ocr.recognize_words(img, 2, "unknown")

    def test_topband_preserves_full_image_dimensions_and_detector_size(self):
        calls = []

        class FakeModel:
            names = {}

            def __init__(self, *_):
                pass

            def __call__(self, image, **kwargs):
                calls.append(kwargs)
                return [types.SimpleNamespace(orig_shape=image.shape[:2], boxes=[])]

        with patch.dict(sys.modules, {"ultralytics": types.SimpleNamespace(YOLO=FakeModel)}):
            yolo = load("yolo_geometry_test", "vision/services/yolo-service/detect.py")
        with patch.object(yolo, "load_image", return_value=np.zeros((200, 400, 3), dtype=np.uint8)):
            response = yolo.app.test_client().post("/detect", json={"topband": True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["image_size"], {"width": 400, "height": 200})
        self.assertEqual(calls[0]["imgsz"], 1280)


if __name__ == "__main__":
    unittest.main()
