'use strict';

/**
 * Browser capture service.
 * Holds ONE persistent Chromium across /capture calls (R3-T9 churn fix:
 * launching + closing a browser per capture cost 15-40s each under load).
 * A fresh page is opened per capture (cheap, isolated); the browser lives
 * until the service stops. Dead browsers are recreated, never reused.
 */

const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const siteRunPaths = require('../../../lib/siteRunPaths');

const app = express();
app.use(express.json());

const PORT = process.env.BROWSER_SERVICE_PORT || 5004;
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'temp_screenshots');

const INVALID_RUN_CONTEXT = 'invalid run context';
function invalidRunContext() {
  return Object.assign(new Error(INVALID_RUN_CONTEXT), { statusCode: 400, sanitized: true });
}

// Explicit body field wins; otherwise env; otherwise null (legacy caller).
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

function resolveCaptureContext(requested) {
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

// ctx => frozen run container screenshots; no ctx => legacy temp_screenshots.
function captureFilePath(ctx, stamp) {
  if (ctx) return siteRunPaths.runPath(ctx, 'screenshots', `capture_${stamp}.png`);
  return path.join(SCREENSHOT_DIR, `ss_${stamp}.png`);
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'browser' }));

let sharedBrowser = null;
async function getBrowser() {
  if (sharedBrowser) {
    let alive = false;
    try { alive = typeof sharedBrowser.isConnected === 'function' ? sharedBrowser.isConnected() : true; }
    catch (_) { alive = false; }
    if (alive) return sharedBrowser;
    try { await sharedBrowser.close(); } catch (_) {}
    sharedBrowser = null;
  }
  // Headful by default (Review-3: operator observes runs). Set
  // VISION_HEADED=false to run headless.
  const HEADED = process.env.VISION_HEADED !== 'false';
  sharedBrowser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 300 : 0, timeout: 90000 });
  return sharedBrowser;
}

async function captureHandler(req, res) {
  const { url, run_context: runContext } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'A valid http(s) URL is required' });
  }
  let ctx;
  try { ctx = resolveCaptureContext(runContext); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    console.log(`[browser] Capturing: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    let fullPath;
    if (ctx) {
      fullPath = captureFilePath(ctx, Date.now());
      fs.mkdirSync(ctx.dirs.screenshots, { recursive: true });
    } else {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      fullPath = captureFilePath(null, Date.now());
    }
    await page.screenshot({ path: fullPath, fullPage: false });

    res.json({ image_path: fullPath, url, viewport: '1280x900' });
  } catch (err) {
    console.error('[browser] Capture failed:', err.message);
    // Browser-level death (not page-level): drop the shared browser so the
    // next capture recreates instead of reusing a corpse.
    if (/closed|disconnected|crash|terminated/i.test(err.message || '')) {
      try { if (sharedBrowser) await sharedBrowser.close(); } catch (_) {}
      sharedBrowser = null;
    }
    res.status(500).json({ error: 'Screenshot capture failed', detail: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

app.post('/capture', captureHandler);

if (require.main === module) {
  app.listen(Number(PORT), '127.0.0.1', () => console.log(`[browser] Browser service running on :${PORT}`));
}

module.exports = { app, captureHandler, resolveCaptureContext, captureFilePath };
