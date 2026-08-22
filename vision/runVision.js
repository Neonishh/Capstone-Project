'use strict';

/**
 * runVision.js — one-shot demo entry point for Architecture B.
 *
 * Starts the browser, merge services (Node), then the YOLO and OCR
 * Python microservices, calls /vision/generate-tests with the target URL,
 * prints results, and shuts everything down.
 *
 * Usage:
 *   node runVision.js [url]
 *
 * Requires:
 *   - Node dependencies installed (npm install in vision/)
 *   - Python deps installed (pip install -r vision/services/yolo-service/requirements.txt
 *     and vision/services/ocr-service/requirements.txt)
 *   - Tesseract OCR installed at the default path or TESSERACT_CMD set
 */

require('dotenv').config();

const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const EXPLORE_MODE = process.argv[2] === '--explore';
const TARGET_URL = (EXPLORE_MODE ? process.argv[3] : process.argv[2]) || 'https://demoqa.com';
const GATEWAY = `http://127.0.0.1:${process.env.VISION_GATEWAY_PORT || 5000}`;
const VISION_ROOT = __dirname;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(url, label, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await axios.get(url, { timeout: 2000 });
      console.log(`[run] ${label} ready`);
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: path.join(VISION_ROOT, ...options.cwdParts),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', (data) => process.stdout.write(`[${options.label}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${options.label}] ${data}`));
  return child;
}

// On Windows the direct children are cmd.exe shells (shell: true), so killing
// them alone leaves the real node/python service processes alive and holding
// ports 5000-5004. Kill the full process tree instead.
function killProcessTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill();
  }
}

(async () => {
  const procs = [];
  let exitCode = 0;

  try {
    console.log(`[run] Target: ${TARGET_URL}`);
    console.log('[run] Starting services...');

    procs.push(
      spawnProcess('node', ['browser.js'], { cwdParts: ['services', 'browser-service'], label: 'browser' }),
      spawnProcess('node', ['merge.js'], { cwdParts: ['services', 'merge-service'], label: 'merge' }),
      spawnProcess('python', ['detect.py'], { cwdParts: ['services', 'yolo-service'], label: 'yolo' }),
      spawnProcess('python', ['ocr.py'], { cwdParts: ['services', 'ocr-service'], label: 'ocr' })
    );

    await waitFor(`${GATEWAY.replace(/:\d+$/, ':5001')}/health`, 'YOLO service');
    await waitFor(`${GATEWAY.replace(/:\d+$/, ':5002')}/health`, 'OCR service');
    await waitFor(`${GATEWAY.replace(/:\d+$/, ':5003')}/health`, 'Merge service');

    // Start gateway last so all downstream services are up.
    const gatewayProc = spawnProcess('node', ['app.js'], { cwdParts: ['gateway'], label: 'gateway' });
    procs.push(gatewayProc);
    await waitFor(`${GATEWAY}/vision/health`, 'Vision gateway');

    console.log(`\n[run] All services healthy. ${EXPLORE_MODE ? 'Starting autonomous exploration...' : 'Generating tests...'}\n`);

    if (EXPLORE_MODE) {
      const { runExploration } = require('./src/explorer');
      const result = await runExploration({ url: TARGET_URL });
      console.log('\n[run] Exploration summary:');
      console.log(JSON.stringify(result.totals, null, 2));
      console.log(`[run] Termination: ${result.termination_reason}`);
      console.log(`[run] Visited URLs:\n  ${result.visited_urls.join('\n  ')}`);
      console.log(`[run] Test cases from history: ${result.test_cases_file}`);
      console.log(`[run] Evidence: ${result.screenshots_dir}`);
    } else {
      const response = await axios.post(
        `${GATEWAY}/vision/generate-tests`,
        { url: TARGET_URL },
        { timeout: 180000 }
      );

      console.log(JSON.stringify(response.data, null, 2));
      console.log(`\n[run] Done. Results saved to ${response.data.saved_to || 'storage/outputs/'}`);
    }
  } catch (err) {
    console.error('[run] Error:', err.message);
    exitCode = 1;
  } finally {
    console.log('\n[run] Shutting down services...');
    await Promise.all(procs.map((proc) => new Promise((resolve) => {
      killProcessTree(proc);
      // Resolve once exited (or after a grace period if already dead).
      if (proc.exitCode !== null) resolve();
      else {
        const timer = setTimeout(resolve, 3000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
      }
    })));
    process.exit(exitCode);
  }
})();
