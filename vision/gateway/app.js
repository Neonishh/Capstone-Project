'use strict';

/**
 * Vision Gateway (Architecture B)
 *
 * Pipeline:
 *   URL -> screenshot -> YOLO detections + OCR words -> visual DOM
 *
 * Runs independently of Architecture A (DOM + memory log).
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const siteRunPaths = require('../../lib/siteRunPaths');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.VISION_GATEWAY_PORT || 5000;

const SERVICES = {
  yolo: process.env.YOLO_SERVICE_URL || 'http://127.0.0.1:5001',
  ocr: process.env.OCR_SERVICE_URL || 'http://127.0.0.1:5002',
  merge: process.env.MERGE_SERVICE_URL || 'http://127.0.0.1:5003',
  browser: process.env.BROWSER_SERVICE_URL || 'http://127.0.0.1:5004',
};

const OUTPUT_DIR = path.join(__dirname, '..', 'storage', 'outputs');
const SCREENSHOT_EVIDENCE_DIR = path.join(__dirname, '..', 'storage', 'screenshots');

const INVALID_RUN_CONTEXT = 'invalid run context';
function invalidRunContext() {
  return Object.assign(new Error(INVALID_RUN_CONTEXT), { statusCode: 400, sanitized: true });
}

// Explicit request field wins; otherwise env; otherwise null (legacy caller).
// A set-but-unusable context is a sanitized 400, never a silent fallback.
function contextRef(requested) {
  // The frozen helper expects an identity object WITH a files map or a path;
  // normalize the documented {site_name,run_id,run_root} shape to its file.
  if (requested && typeof requested === 'object' && typeof requested.run_root === 'string' && !requested.files) {
    return path.join(path.resolve(requested.run_root), 'control', 'run-context.json');
  }
  return requested;
}

function assertRequestedContextIdentity(requested, ctx) {
  if (!requested || typeof requested !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(requested, 'site_name') && requested.site_name !== ctx.site_name) throw invalidRunContext();
  if (Object.prototype.hasOwnProperty.call(requested, 'run_id') && requested.run_id !== ctx.run_id) throw invalidRunContext();
  if (Object.prototype.hasOwnProperty.call(requested, 'run_root') &&
      (typeof requested.run_root !== 'string' || path.relative(ctx.run_root, path.resolve(requested.run_root)) !== '')) throw invalidRunContext();
}

function resolveRequestRunContext(requested) {
  let ctx = null;
  try {
    if (requested !== undefined && requested !== null) {
      ctx = siteRunPaths.loadRunContext(contextRef(requested));
      assertRequestedContextIdentity(requested, ctx);
    }
    else if (process.env && process.env.SITE_RUN_CONTEXT) ctx = siteRunPaths.contextFromEnv(process.env);
  } catch (_) {
    throw invalidRunContext();
  }
  if (ctx) {
    try { siteRunPaths.assertRunContext(ctx, { writable: true }); }
    catch (_) { throw invalidRunContext(); }
  }
  return ctx;
}

function visualDomOutputPath(ctx, runId, resolvedPath) {
  if (ctx) return siteRunPaths.runPath(ctx, 'outputs', `${ctx.run_id}_visual_dom.json`);
  const base = runId || path.basename(resolvedPath, path.extname(resolvedPath));
  return path.join(OUTPUT_DIR, `${base}_visual_dom.json`);
}

function writeEvidenceB64(runDir, fileName, b64) {
  const filePath = path.join(runDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  return filePath;
}

// Ask the YOLO service to render arbitrary boxes/labels onto an image.
async function renderBoxes(payload) {
  try {
    const res = await axios.post(
      `${SERVICES.yolo}/render_boxes`,
      payload,
      { timeout: 30000 }
    );
    return res.data.annotated_image_b64 || null;
  } catch (err) {
    console.error('[gateway] Evidence rendering failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/vision/health', async (_req, res) => {
  const checks = await Promise.all(
    Object.entries(SERVICES).map(async ([name, url]) => {
      try {
        const response = await axios.get(`${url}/health`, { timeout: 3000 });
        return { name, status: response.data.status || 'ok' };
      } catch {
        return { name, status: 'unreachable' };
      }
    })
  );
  res.json({ service: 'vision-gateway', checks });
});

// ---------------------------------------------------------------------------
// Visual DOM pipeline
// ---------------------------------------------------------------------------

// All callers share one inference lane. A failed request drains before its successor.
let inferenceTail = Promise.resolve();
function buildVisualDOM(input = {}, options = {}) {
  const operation = inferenceTail.then(() => buildVisualDOMUnqueued(input, options));
  inferenceTail = operation.catch(() => {});
  return operation;
}

async function buildVisualDOMUnqueued(input = {}, options = {}) {
  const { url, image_path: imagePath, image_b64: imageB64, run_id: requestedRunId, conf: requestedConf, crop_topband: requestedCrop, run_context: requestedRunContext } = input;
  const ctx = options.contextResolved === true ? options.ctx : resolveRequestRunContext(requestedRunContext);
  let resolvedPath = imagePath;
  let payload;

  // Evidence run directory: every URL-based pipeline run gets a unique folder
  // under storage/screenshots/ so previous runs are never overwritten. With an
  // explicit run context the frozen site-run-v1 container owns the folder.
  let runId = null;
  let runDir = null;
  if (url) {
    runId = ctx ? ctx.run_id : (requestedRunId || `run_${Date.now()}`);
    runDir = ctx ? ctx.dirs.screenshots : path.join(SCREENSHOT_EVIDENCE_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
  }

  if (url) {
    const captureBody = { url };
    if (ctx) captureBody.run_context = { site_name: ctx.site_name, run_id: ctx.run_id, run_root: ctx.run_root };
    const capture = await axios.post(
      `${SERVICES.browser}/capture`,
      captureBody,
      { timeout: 45000 }
    );
    resolvedPath = capture.data.image_path;
    // Preserve the original screenshot as the run's initial state.
    try {
      fs.copyFileSync(resolvedPath, path.join(runDir, 'state_001_initial.png'));
    } catch (err) {
      console.error('[gateway] Failed to preserve initial screenshot:', err.message);
    }
  }

  if (!resolvedPath && !imageB64) {
    throw Object.assign(new Error('Provide image_path, image_b64, or url'), { statusCode: 400 });
  }

  if (resolvedPath) {
    if (!fs.existsSync(resolvedPath)) {
      throw Object.assign(new Error(`Screenshot not found: ${resolvedPath}`), { statusCode: 404 });
    }
    payload = { image_path: resolvedPath };
  } else {
    payload = { image_b64: imageB64 };
  }

  const detectPayload = { ...payload };
  // Optional per-request YOLO threshold (used for the T5 low-confidence retry).
  if (typeof requestedConf === 'number' && Number.isFinite(requestedConf) &&
      requestedConf >= 0 && requestedConf <= 1) {
    detectPayload.conf = requestedConf;
  }
  // M3 Fix A: top-band crop + upscale re-detect for faint empty inputs.
  if (requestedCrop === true) detectPayload.topband = true;
  if (runDir) detectPayload.annotate = true;

  const inference = await Promise.allSettled([
    axios.post(`${SERVICES.yolo}/detect`, detectPayload, { timeout: 60000 }),
    axios.post(`${SERVICES.ocr}/extract`, payload, { timeout: 60000 }),
  ]);
  const failure = inference.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const [yoloRes, ocrRes] = inference.map(result => result.value);

  // YOLO evidence image (boxes + class + confidence).
  if (runDir && yoloRes.data.annotated_image_b64) {
    try {
      writeEvidenceB64(runDir, 'state_001_yolo.png', yoloRes.data.annotated_image_b64);
    } catch (err) {
      console.error('[gateway] Failed to write YOLO evidence:', err.message);
    }
  }

  const mergeRes = await axios.post(
    `${SERVICES.merge}/merge`,
    {
      detections: yoloRes.data.detections,
      ocr_words: ocrRes.data.words,
      image_size: yoloRes.data.image_size,
    },
    { timeout: 10000 }
  );

  const visualDOM = mergeRes.data;
  visualDOM.raw = {
    yolo_detections: yoloRes.data.detections.length,
    ocr_words_found: ocrRes.data.words.length,
    full_text: ocrRes.data.full_text,
  };

  if (url) visualDOM.source_url = url;

  // OCR + merged visual-DOM evidence images.
  if (runDir) {
    const screenshots = {
      initial: path.join(runDir, 'state_001_initial.png'),
      yolo: path.join(runDir, 'state_001_yolo.png'),
      ocr: path.join(runDir, 'state_001_ocr.png'),
      merged: path.join(runDir, 'state_001_merged.png'),
    };

    const ocrAnnotations = ocrRes.data.words.slice(0, 120).map((w) => ({
      bbox: [w.bbox.x, w.bbox.y, w.bbox.x + w.bbox.w, w.bbox.y + w.bbox.h],
      lines: [w.text, String(w.conf)],
      color: [0, 160, 255],
    }));
    let b64 = await renderBoxes({ image_path: resolvedPath, annotations: ocrAnnotations });
    if (b64) { try { writeEvidenceB64(runDir, 'state_001_ocr.png', b64); } catch (_) {} }

    const mergedAnnotations = (visualDOM.elements || []).slice(0, 60).map((el) => ({
      bbox: [el.bbox.x1, el.bbox.y1, el.bbox.x2, el.bbox.y2],
      lines: [
        `${el.type} ${el.id}`,
        `yolo=${el.confidence ? el.confidence.yolo : '?'}`,
        el.text || '',
      ],
      color: [255, 200, 0],
    }));
    b64 = await renderBoxes({ image_path: resolvedPath, annotations: mergedAnnotations });
    if (b64) { try { writeEvidenceB64(runDir, 'state_001_merged.png', b64); } catch (_) {} }

    visualDOM.run_id = runId;
    visualDOM.screenshots = screenshots;
  }

  if (resolvedPath) {
    // Run-scoped naming keeps every run's outputs separate and traceable.
    const outFile = visualDomOutputPath(ctx, runId, resolvedPath);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(visualDOM, null, 2));
    visualDOM.saved_to = outFile;
  }

  return visualDOM;
}

async function processHandler(req, res) {
  const start = Date.now();
  try {
    const visualDOM = await buildVisualDOM(req.body);
    visualDOM.processing_ms = Date.now() - start;
    res.json(visualDOM);
  } catch (err) {
    if (err && err.statusCode === 400 && err.sanitized) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[gateway] Pipeline error:', err.message);
    res.status(err.statusCode || 500).json({
      error: 'Vision pipeline failed',
      detail: err.message,
    });
  }
}

app.post('/vision/process', processHandler);

if (require.main === module) {
  app.listen(Number(PORT), '127.0.0.1', () => console.log(`[gateway] Vision gateway running on 127.0.0.1:${PORT}`));
}

module.exports = {
  app,
  buildVisualDOM,
  resolveRequestRunContext,
  visualDomOutputPath,
  processHandler,
};
