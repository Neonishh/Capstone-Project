'use strict';

/**
 * runBoth.js — unified Capstone demo runner.
 *
 * Runs Architecture A (DOM + Memory Log, web/) and Architecture B (Vision,
 * vision/) against the SAME URL in parallel under ONE shared run ID.
 *
 * The runner is ONLY an orchestrator: both architectures keep their own
 * internal pipelines, ports and output locations untouched. When each
 * finishes, its artifacts are COLLECTED into a shared run folder:
 *
 *   runs/<run_id>/
 *     run_manifest.json
 *     dom/      <- Architecture A artifacts (memory log, screenshots, ...)
 *     vision/   <- Architecture B artifacts (evidence, visual DOMs, tests...)
 *
 * Usage:
 *   node runBoth.js [url]
 *   (interactive prompt when no URL is given; default https://demoqa.com)
 *
 * Optional environment overrides:
 *   ARCH_A_TIMEOUT_MS  (default 900000 = 15 min)
 *   ARCH_B_TIMEOUT_MS  (default 900000 = 15 min)
 *
 * API keys are NEVER hard-coded: GROQ_API_KEY is taken from the process
 * environment or from the existing untracked .env files (web/.env,
 * vision/.env). Secrets are never printed.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const net = require('net');

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const VISION_DIR = path.join(ROOT, 'vision');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function log(channel, msg) {
  console.log(`[${channel}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Environment handling (no secrets printed)
// ---------------------------------------------------------------------------

function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (_) { /* file optional */ }
  return out;
}

/** Resolve the child env without ever echoing secret values. */
function buildChildEnv() {
  const env = { ...process.env };
  if (!env.GROQ_API_KEY) {
    // Both architectures use the same variable name already; borrow it from
    // the existing untracked .env conventions if the shell did not provide it.
    for (const f of [path.join(VISION_DIR, '.env'), path.join(WEB_DIR, '.env')]) {
      const vals = loadEnvFile(f);
      if (vals.GROQ_API_KEY) {
        env.GROQ_API_KEY = vals.GROQ_API_KEY;
        break;
      }
    }
  }
  env.GROQ_API_KEY_SET = env.GROQ_API_KEY ? 'true' : 'false';
  return env;
}

// ---------------------------------------------------------------------------
// Port safety (Vision uses 5000-5004)
// ---------------------------------------------------------------------------

function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

async function freeVisionPorts() {
  const ports = [5000, 5001, 5002, 5003, 5004];
  for (const port of ports) {
    if (!(await isPortOpen(port))) continue;
    log('RUN', `Port ${port} busy — freeing leftover process...`);
    try {
      const out = execSync('netstat -ano', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(`:${port} `) && line.includes('LISTENING')) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && /^\d+$/.test(pid)) pids.add(pid);
        }
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch (_) {}
      }
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      log('RUN', `Could not free port ${port}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Child-process plumbing
// ---------------------------------------------------------------------------

function teeSpawn(label, command, args, cwd, env, timeoutMs, logFilePath) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    logStream.write(`\n===== ${label} started ${new Date().toISOString()} =====\n`);

    const child = spawn(command, args, { cwd, env }); // no shell: keeps args with spaces intact
    let timedOut = false;

    const pipe = (stream, isErr) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          console.log(`[${label}] ${line}`);
          logStream.write(line + '\n');
        }
      }).on('close', () => {
        if (buf.trim()) {
          console.log(`[${label}] ${buf}`);
          logStream.write(buf + '\n');
        }
      });
    };
    pipe(child.stdout, false);
    pipe(child.stderr, true);

    const timer = setTimeout(() => {
      timedOut = true;
      console.log(`[${label}] Timeout (${Math.round(timeoutMs / 60000)} min) — terminating process tree...`);
      try {
        if (process.platform === 'win32' && child.pid) {
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
          child.kill();
        }
      } catch (_) {}
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      logStream.end(`\n===== exited code=${code} timedOut=${timedOut} =====\n`);
      resolve({
        status: timedOut ? 'timeout' : (code === 0 ? 'success' : `failed(exit ${code})`),
        exitCode: code,
        duration_ms: Date.now() - startedAt,
        log_file: path.relative(ROOT, logFilePath),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Artifact collection into the unified run tree
// ---------------------------------------------------------------------------

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function collectArchitectureA(domDir) {
  const copied = [];
  const srcLog = path.join(WEB_DIR, 'logs');
  if (fs.existsSync(path.join(srcLog, 'memory_log.json'))) {
    fs.copyFileSync(path.join(srcLog, 'memory_log.json'), path.join(domDir, 'memory_log.json'));
    copied.push('memory_log.json');
  }
  if (fs.existsSync(path.join(srcLog, 'test_cases.json'))) {
    fs.copyFileSync(path.join(srcLog, 'test_cases.json'), path.join(domDir, 'test_cases.json'));
    copied.push('test_cases.json');
  }
  const shots = path.join(srcLog, 'screenshots');
  if (fs.existsSync(shots)) {
    copyDir(shots, path.join(domDir, 'screenshots'));
    copied.push(`screenshots/ (${fs.readdirSync(path.join(domDir, 'screenshots')).length} files)`);
  }
  return copied;
}

function collectArchitectureB(visionDir, startedAt) {
  const copied = [];
  const shotsRoot = path.join(VISION_DIR, 'storage', 'screenshots');
  if (fs.existsSync(shotsRoot)) {
    for (const dir of fs.readdirSync(shotsRoot)) {
      const full = path.join(shotsRoot, dir);
      if (fs.statSync(full).mtimeMs >= startedAt - 5000) { // this run's evidence only
        copyDir(full, path.join(visionDir, 'screenshots', dir));
        copied.push(`screenshots/${dir}/ (${fs.readdirSync(full).length} files)`);
      }
    }
  }
  const outs = path.join(VISION_DIR, 'storage', 'outputs');
  const destOut = path.join(visionDir, 'outputs');
  fs.mkdirSync(destOut, { recursive: true });
  for (const f of fs.readdirSync(outs)) {
    const full = path.join(outs, f);
    if (fs.statSync(full).isFile() && fs.statSync(full).mtimeMs >= startedAt - 5000) {
      fs.copyFileSync(full, path.join(destOut, f));
      copied.push(`outputs/${f}`);
    }
  }
  return copied;
}

// ---------------------------------------------------------------------------

async function askUrl() {
  if (process.argv[2]) return process.argv[2];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question('Enter website URL [https://demoqa.com]: ', res));
  rl.close();
  return answer.trim() || 'https://demoqa.com';
}

(async () => {
  const url = await askUrl();
  const runId = `run_${ts()}`;
  const runDir = path.join(ROOT, 'runs', runId);
  const domDir = path.join(runDir, 'dom');
  const visionDir = path.join(runDir, 'vision');
  for (const d of [domDir, visionDir]) fs.mkdirSync(d, { recursive: true });

  log('RUN', `Run ID: ${runId}`);
  log('RUN', `URL: ${url}`);
  log('RUN', `Output tree: ${path.relative(process.cwd(), runDir)}`);

  const childEnv = buildChildEnv();
  log('RUN', `GROQ_API_KEY available: ${childEnv.GROQ_API_KEY_SET}`);

  await freeVisionPorts();

  const archATimeout = Number(process.env.ARCH_A_TIMEOUT_MS) || 15 * 60 * 1000;
  const archBTimeout = Number(process.env.ARCH_B_TIMEOUT_MS) || 15 * 60 * 1000;

  log('ARCH-A', 'Starting... (DOM + memory-log exploration)');
  log('ARCH-B', 'Starting... (Vision pipeline: capture -> YOLO/OCR -> visual DOM -> LLM tests -> execution)');

  const runStartedAt = Date.now();

  // ----- Architecture B: generate, then execute with the permanent executor.
  const archBPromise = (async () => {
    const gen = await teeSpawn(
      'ARCH-B', 'node', ['runVision.js', url], VISION_DIR, childEnv, archBTimeout,
      path.join(visionDir, 'run_generate.log')
    );
    if (gen.status !== 'success') {
      return { ...gen, stage: 'generation', collected: [] };
    }
    // Execute ONLY the test cases belonging to the Vision run created in THIS
    // unified run. Never fall back to stale files from previous runs.
    const outDir = path.join(VISION_DIR, 'storage', 'outputs');
    const vdomFile = fs.readdirSync(outDir)
      .map((f) => {
        const m = f.match(/^(run_\d+)_visual_dom\.json$/);
        if (!m) return null;
        const full = path.join(outDir, f);
        return { runId: m[1], full, t: fs.statSync(full).mtimeMs };
      })
      .filter((x) => x && x.t >= runStartedAt - 5000)
      .sort((a, b) => b.t - a.t)[0];

    if (!vdomFile) {
      return {
        status: 'partial_success',
        stage: 'generation-produced-no-visual-dom',
        duration_ms: gen.duration_ms,
        collected: [],
      };
    }
    const tcPath = path.join(outDir, `test_cases_${vdomFile.runId}_visual_dom.json`);
    if (!fs.existsSync(tcPath)) {
      // Visual DOM exists but the LLM produced no usable test cases for this run.
      return {
        status: 'partial_success',
        stage: 'generation-produced-no-test-cases',
        vision_run_id: vdomFile.runId,
        duration_ms: gen.duration_ms,
        collected: [],
      };
    }
    const exec = await teeSpawn(
      'ARCH-B', 'node',
      ['src/executeTests.js', tcPath, url],
      VISION_DIR, childEnv, archBTimeout,
      path.join(visionDir, 'run_execute.log')
    );
    const status = exec.status === 'success'
      ? 'success'
      : (exec.status === 'timeout' ? 'timeout' : 'partial_success'); // generation ok, execution issues
    return {
      status, stage: 'execution', vision_run_id: vdomFile.runId, exit_code: exec.exitCode,
      duration_ms: gen.duration_ms + exec.duration_ms, collected: [],
    };
  })();

  // ----- Architecture A: exploration (its own entry point, unchanged).
  const archAPromise = (async () => {
    const res = await teeSpawn(
      'ARCH-A', 'node', ['explore.js', url], WEB_DIR, childEnv, archATimeout,
      path.join(domDir, 'run_explore.log')
    );
    if (res.status === 'success') {
      // Use A's own modules to finish its documented pipeline (test cases).
      try {
        execSync(
          'node -e "const {generateTestCases}=require(\'./src/testGenerator\');' +
          'const {loadLog}=require(\'./src/memoryLog\');' +
          'generateTestCases(loadLog(\'logs/memory_log.json\'))"',
          { cwd: WEB_DIR, env: childEnv, stdio: 'inherit', timeout: 120000, shell: true }
        );
      } catch (err) {
        log('ARCH-A', `Test-case generation step failed: ${err.message.slice(0, 120)}`);
      }
    }
    return res;
  })();

  const [archA, archBraw] = await Promise.all([archAPromise, archBPromise]);

  log('RUN', 'Collecting artifacts into unified run tree...');
  const aCopied = collectArchitectureA(domDir);
  const bCollected = collectArchitectureB(visionDir, runStartedAt);
  const archB = { ...archBraw, collected: bCollected };

  const overall = archA.status === 'success' && archB.status === 'success'
    ? 'SUCCESS'
    : (archA.status === 'success' || archB.status === 'success' ? 'PARTIAL_FAILURE' : 'FAILED');

  const manifest = {
    run_id: runId,
    url,
    started_at: new Date(runStartedAt).toISOString(),
    finished_at: new Date().toISOString(),
    overall_status: overall,
    architecture_a: {
      name: 'DOM + Memory Log (web/)',
      ...archA,
      collected_artifacts: aCopied,
      output_dir: path.relative(ROOT, domDir),
    },
    architecture_b: {
      name: 'Vision (vision/)',
      ...archB,
      output_dir: path.relative(ROOT, visionDir),
    },
  };
  const manifestPath = path.join(runDir, 'run_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log('\n=========================================');
  log('RUN', `Architecture A: ${archA.status}`);
  log('RUN', `Architecture B: ${archB.status}`);
  log('RUN', `Overall run: ${overall}`);
  console.log('[RUN] Results:');
  console.log(`  DOM:    ${path.relative(process.cwd(), domDir)}`);
  console.log(`       -> ${aCopied.join(', ') || '(no artifacts produced)'}`);
  console.log(`  VISION: ${path.relative(process.cwd(), visionDir)}`);
  console.log(`       -> ${bCollected.length} artifact(s)`);
  console.log(`Manifest:\n  ${path.relative(process.cwd(), manifestPath)}`);
  console.log('=========================================');
  process.exit(overall === 'FAILED' ? 1 : 0);
})();
