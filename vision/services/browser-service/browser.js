'use strict';

/**
 * Browser capture service.
 * Opens a URL in headless Chromium and saves a full-page screenshot.
 */

const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.BROWSER_SERVICE_PORT || 5004;
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'temp_screenshots');

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'browser' }));

app.post('/capture', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'A valid http(s) URL is required' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    console.log(`[browser] Capturing: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filename = `ss_${Date.now()}.png`;
    const fullPath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: fullPath, fullPage: false });

    res.json({ image_path: fullPath, url, viewport: '1280x900' });
  } catch (err) {
    console.error('[browser] Capture failed:', err.message);
    res.status(500).json({ error: 'Screenshot capture failed', detail: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`[browser] Browser service running on :${PORT}`));
