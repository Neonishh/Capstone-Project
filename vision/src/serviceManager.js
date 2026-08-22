'use strict';

/**
 * serviceManager.js — Vision service lifecycle for long-running consumers.
 *
 * Used by executeTests.js so closed-loop re-detection works even when no
 * runVision.js process is alive. Starts only the services that are not
 * already healthy, waits for health, and can shut down everything it started
 * (Windows-safe process-tree kill, same pattern as runVision.js).
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const axios = require('axios');

const VISION_ROOT = path.join(__dirname, '..');

const SERVICE_DEFS = [
  { name: 'browser-service', cmd: 'node', file: 'browser.js', cwd: ['services', 'browser-service'], health: 'http://127.0.0.1:5004/health' },
  { name: 'merge-service', cmd: 'node', file: 'merge.js', cwd: ['services', 'merge-service'], health: 'http://127.0.0.1:5003/health' },
  { name: 'ocr-service', cmd: 'python', file: 'ocr.py', cwd: ['services', 'ocr-service'], health: 'http://127.0.0.1:5002/health' },
  { name: 'yolo-service', cmd: 'python', file: 'detect.py', cwd: ['services', 'yolo-service'], health: 'http://127.0.0.1:5001/health' },
];
const GATEWAY_DEF = { name: 'gateway', cmd: 'node', file: 'app.js', cwd: ['gateway'], health: 'http://127.0.0.1:5000/vision/health' };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function isHealthy(url, timeoutMs = 2000) {
  try {
    await axios.get(url, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc.kill();
    }
  } catch (_) {}
}

/**
 * Ensure the gateway and all downstream Vision services are healthy.
 * Starts ONLY what is missing; never touches pre-existing processes.
 * Returns { ok, started, alreadyRunning } — call shutdownVisionServices()
 * with the returned object when done.
 */
async function ensureVisionServices({ startupTimeoutMs = 120000 } = {}) {
  const started = [];
  let alreadyRunning = 0;

  const spawnIfDown = async (def) => {
    if (await isHealthy(def.health)) {
      alreadyRunning += 1;
      return null;
    }
    const child = spawn(def.cmd, [def.file], {
      cwd: path.join(VISION_ROOT, ...def.cwd),
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: process.platform === 'win32',
    });
    started.push({ def, child });
    return child;
  };

  // Downstream services first, gateway last (mirrors runVision.js ordering).
  for (const def of SERVICE_DEFS) await spawnIfDown(def);
  await spawnIfDown(GATEWAY_DEF);

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(GATEWAY_DEF.health)) {
      return { ok: true, started, alreadyRunning };
    }
    await sleep(1500);
  }
  return { ok: false, started, alreadyRunning };
}

/** Shut down every process this manager started (never external ones). */
async function shutdownVisionServices(handle) {
  if (!handle || !Array.isArray(handle.started)) return;
  for (const { child } of handle.started) killTree(child);
  // Give Windows a moment to release ports.
  await sleep(800);
}

module.exports = { ensureVisionServices, shutdownVisionServices };
