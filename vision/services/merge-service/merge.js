'use strict';

/**
 * Merge service.
 * Combines YOLO detections and OCR word boxes into a visual DOM.
 * A word belongs to a detection when its centre lies inside the box
 * or the IoU overlap exceeds 0.1.
 */

const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.MERGE_SERVICE_PORT || 5003;

function iou(box, word) {
  const [bx1, by1, bx2, by2] = box;
  const wx1 = word.bbox.x;
  const wy1 = word.bbox.y;
  const wx2 = wx1 + word.bbox.w;
  const wy2 = wy1 + word.bbox.h;

  const ix1 = Math.max(bx1, wx1);
  const iy1 = Math.max(by1, wy1);
  const ix2 = Math.min(bx2, wx2);
  const iy2 = Math.min(by2, wy2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;

  const intersection = (ix2 - ix1) * (iy2 - iy1);
  const union = (bx2 - bx1) * (by2 - by1) + word.bbox.w * word.bbox.h - intersection;
  return intersection / union;
}

function wordCenterInsideBox(box, word) {
  const cx = word.bbox.x + word.bbox.w / 2;
  const cy = word.bbox.y + word.bbox.h / 2;
  return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
}

function sortWords(words) {
  return [...words].sort((a, b) => {
    const rowDiff = a.bbox.y - b.bbox.y;
    return Math.abs(rowDiff) < 8 ? a.bbox.x - b.bbox.x : rowDiff;
  });
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'merge' }));

app.post('/merge', (req, res) => {
  const { detections, ocr_words: ocrWords, image_size: imageSize } = req.body || {};
  if (!Array.isArray(detections) || !Array.isArray(ocrWords)) {
    return res.status(400).json({ error: 'detections and ocr_words arrays are required' });
  }

  const elements = detections.map((det, index) => {
    const matched = ocrWords.filter(
      (w) => wordCenterInsideBox(det.bbox, w) || iou(det.bbox, w) > 0.1
    );
    const ordered = sortWords(matched);
    const text = ordered.map((w) => w.text).join(' ').trim() || null;
    const avgConf = matched.length
      ? matched.reduce((sum, w) => sum + w.conf, 0) / matched.length
      : 0;

    return {
      id: `elem-${index}`,
      type: det.type,
      yolo_label: det.label,
      text,
      bbox: { x1: det.bbox[0], y1: det.bbox[1], x2: det.bbox[2], y2: det.bbox[3] },
      confidence: {
        yolo: det.confidence,
        ocr: Math.round(avgConf),
        combined: parseFloat((det.confidence * (avgConf / 100 || 0.5)).toFixed(3)),
      },
      word_count: matched.length,
    };
  });

  res.json({
    source: 'vision-pipeline',
    architecture: 'B',
    image_size: imageSize || null,
    timestamp: new Date().toISOString(),
    element_count: elements.length,
    elements,
  });
});

app.listen(PORT, () => console.log(`[merge] Merge service running on :${PORT}`));
