'use strict';
const fs = require('fs');
const path = require('path');

const LAYOUT_VERSION = 'site-run-v1';
const AREAS = ['logs', 'screenshots', 'outputs', 'control'];
const ROOT_ARTIFACTS = ['SITE_RUN_REPORT.md', 'manifest.json', 'report.json'];
const RESERVED_COMPONENTS = new Set(['..', '.', 'SITE_RUN_REPORT.md', 'manifest.json', 'report.json']);
const SAFE_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeComponent(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    SAFE_COMPONENT_RE.test(value) && !RESERVED_COMPONENTS.has(value);
}

function assertSafeComponent(value, label) {
  if (!isSafeComponent(value)) throw new Error('invalid ' + label + ': ' + String(value));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonExclusive(file, obj) {
  const data = JSON.stringify(obj, null, 2) + '\n';
  const fd = fs.openSync(file, 'wx');
  try { fs.writeSync(fd, data); }
  finally { fs.closeSync(fd); }
}

function realpathOrResolve(p) {
  try { return fs.realpathSync(p); }
  catch (e) { return path.resolve(p); }
}

function nearestExistingAncestor(p) {
  let cur = path.resolve(p);
  while (true) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function containmentCheck(baseDir, target) {
  const baseReal = realpathOrResolve(baseDir);
  const targetReal = realpathOrResolve(nearestExistingAncestor(target));
  if (!isInside(baseReal, targetReal)) throw new Error('path escapes containment: ' + target);
  // also ensure resolved target stays under base even if target doesn't exist
  const resolved = path.resolve(target);
  if (!isInside(path.resolve(baseDir), resolved)) throw new Error('path escapes containment: ' + target);
}

function makeContext(site_name, run_id, run_root, sealed) {
  const absRoot = path.resolve(run_root);
  const dirs = {
    logs: path.join(absRoot, 'logs'),
    screenshots: path.join(absRoot, 'screenshots'),
    outputs: path.join(absRoot, 'outputs'),
    control: path.join(absRoot, 'control')
  };
  const files = {
    context: path.join(absRoot, 'control', 'run-context.json'),
    report_md: path.join(absRoot, 'SITE_RUN_REPORT.md'),
    manifest: path.join(absRoot, 'manifest.json'),
    report_json: path.join(absRoot, 'report.json'),
    seal: path.join(absRoot, 'control', 'seal.json')
  };
  const ctx = {
    layout_version: LAYOUT_VERSION,
    site_name: site_name,
    run_id: run_id,
    run_root: absRoot,
    dirs: dirs,
    files: files,
    sealed: !!sealed
  };
  // freeze nested
  Object.freeze(dirs);
  Object.freeze(files);
  return Object.freeze(ctx);
}

function serializeContext(ctx) {
  return {
    layout_version: ctx.layout_version,
    site_name: ctx.site_name,
    run_id: ctx.run_id,
    run_root: ctx.run_root,
    paths: {
      logs: 'logs',
      screenshots: 'screenshots',
      outputs: 'outputs',
      control: 'control',
      context_file: 'control/run-context.json',
      report_md: 'SITE_RUN_REPORT.md',
      manifest: 'manifest.json',
      report_json: 'report.json'
    },
    sealed: ctx.sealed
  };
}

function validateContextShape(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('context must be object');
  if (ctx.layout_version !== LAYOUT_VERSION) throw new Error('invalid layout_version');
  assertSafeComponent(ctx.site_name, 'site_name');
  assertSafeComponent(ctx.run_id, 'run_id');
  if (typeof ctx.run_root !== 'string' || ctx.run_root.length === 0) throw new Error('invalid run_root');
  if (ctx.run_root !== path.resolve(ctx.run_root)) throw new Error('run_root must be absolute resolved');
}

function createRunContext(options) {
  options = options || {};
  const site_name = options.site_name;
  const run_id = options.run_id;
  assertSafeComponent(site_name, 'site_name');
  assertSafeComponent(run_id, 'run_id');
  const storage_root = options.storage_root ? path.resolve(options.storage_root) : process.cwd();
  const run_root = path.join(storage_root, 'site_report', site_name + '_' + run_id);
  // exclusive reservation: parent may be created; run_root must not exist
  ensureDir(path.join(storage_root, 'site_report'));
  // atomic-ish: mkdirSync without recursive throws EEXIST
  try {
    fs.mkdirSync(run_root, { recursive: false });
  } catch (e) {
    if (e && (e.code === 'EEXIST' || e.code === 'ENOTEMPTY')) {
      throw new Error('run root already exists (refused): ' + run_root);
    }
    throw e;
  }
  // create subdirs
  for (const a of AREAS) {
    fs.mkdirSync(path.join(run_root, a), { recursive: true });
  }
  const ctx = makeContext(site_name, run_id, run_root, false);
  // write context file
  const serialized = serializeContext(ctx);
  const controlDir = path.join(run_root, 'control');
  ensureDir(controlDir);
  writeJsonExclusive(path.join(controlDir, 'run-context.json'), serialized);
  return ctx;
}

function loadRunContext(contextOrFile) {
  let filePath = null;
  let providedRoot = null;
  if (typeof contextOrFile === 'string') {
    const p = path.resolve(contextOrFile);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      filePath = path.join(p, 'control', 'run-context.json');
      providedRoot = p;
    } else {
      filePath = p;
    }
  } else if (contextOrFile && typeof contextOrFile === 'object') {
    if (typeof contextOrFile.run_root === 'string') providedRoot = path.resolve(contextOrFile.run_root);
    if (typeof contextOrFile.files && typeof contextOrFile.files.context === 'string') {
      filePath = path.resolve(contextOrFile.files.context);
    } else if (typeof contextOrFile.context_file === 'string') {
      filePath = path.resolve(contextOrFile.context_file);
    }
  }
  if (!filePath) {
    // try providedRoot
    if (providedRoot) filePath = path.join(providedRoot, 'control', 'run-context.json');
  }
  if (!filePath || !fs.existsSync(filePath)) throw new Error('context file not found: ' + String(filePath));
  const stored = readJson(filePath);
  if (stored.layout_version !== LAYOUT_VERSION) throw new Error('invalid layout_version in context');
  assertSafeComponent(stored.site_name, 'site_name');
  assertSafeComponent(stored.run_id, 'run_id');
  const run_root = path.resolve(stored.run_root);
  if (!fs.existsSync(run_root) || !fs.statSync(run_root).isDirectory()) throw new Error('run_root missing: ' + run_root);
  // physical parent containment: run_root must be .../site_report/<slug>
  const parent = path.basename(path.dirname(run_root));
  if (parent !== 'site_report') throw new Error('run_root not under site_report: ' + run_root);
  const slug = path.basename(run_root);
  if (slug !== stored.site_name + '_' + stored.run_id) throw new Error('run_root slug mismatch');
  // verify stored derived paths match expected
  const expectedPaths = {
    logs: 'logs', screenshots: 'screenshots', outputs: 'outputs', control: 'control',
    context_file: 'control/run-context.json', report_md: 'SITE_RUN_REPORT.md',
    manifest: 'manifest.json', report_json: 'report.json'
  };
  if (!stored.paths || typeof stored.paths !== 'object') throw new Error('missing paths in context');
  for (const k of Object.keys(expectedPaths)) {
    if (stored.paths[k] !== expectedPaths[k]) throw new Error('derived path mismatch: ' + k);
  }
  // physical containment: realpath run_root equals resolved (no symlink escape of root itself)
  const realRoot = fs.realpathSync(run_root);
  if (realRoot !== run_root) {
    // allow if realpath still under site_report with same slug? require exact equality for safety
    throw new Error('run_root symlink/realpath mismatch: ' + run_root);
  }
  // if providedRoot given, must match
  if (providedRoot && path.resolve(providedRoot) !== run_root) {
    throw new Error('provided run_root mismatch');
  }
  // sealed?
  const sealFile = path.join(run_root, 'control', 'seal.json');
  const sealed = fs.existsSync(sealFile);
  return makeContext(stored.site_name, stored.run_id, run_root, sealed);
}

function assertRunContext(context, options) {
  options = options || {};
  validateContextShape(context);
  if (!fs.existsSync(context.run_root) || !fs.statSync(context.run_root).isDirectory()) {
    throw new Error('run_root missing: ' + context.run_root);
  }
  const parent = path.basename(path.dirname(context.run_root));
  if (parent !== 'site_report') throw new Error('run_root not under site_report');
  const slug = path.basename(context.run_root);
  if (slug !== context.site_name + '_' + context.run_id) throw new Error('slug mismatch');
  const realRoot = fs.realpathSync(context.run_root);
  if (realRoot !== context.run_root) throw new Error('run_root realpath mismatch');
  // verify context file exists and matches
  if (!fs.existsSync(context.files.context)) throw new Error('context file missing');
  const stored = readJson(context.files.context);
  if (stored.layout_version !== context.layout_version) throw new Error('context version mismatch');
  if (stored.site_name !== context.site_name || stored.run_id !== context.run_id) throw new Error('context identity mismatch');
  if (options.writable) {
    const sealFile = context.files.seal;
    if (fs.existsSync(sealFile)) throw new Error('run is sealed (not writable)');
  }
  // verify subdirs
  for (const a of AREAS) {
    if (!fs.existsSync(context.dirs[a]) || !fs.statSync(context.dirs[a]).isDirectory()) {
      throw new Error('missing area dir: ' + a);
    }
  }
  return true;
}

function runPath(context, area, relative) {
  assertRunContext(context, { writable: false });
  if (AREAS.indexOf(area) === -1) throw new Error('unknown area: ' + area);
  if (typeof relative !== 'string' || relative.length === 0) throw new Error('relative path required');
  if (path.isAbsolute(relative)) throw new Error('absolute path rejected: ' + relative);
  // normalize and check traversal
  const normalized = path.posix.normalize(relative.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('traversal rejected: ' + relative);
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('empty relative path');
  for (const part of parts) {
    if (part === '..' || part === '.' ) throw new Error('traversal rejected: ' + relative);
    if (RESERVED_COMPONENTS.has(part)) throw new Error('reserved name rejected: ' + part);
  }
  const areaDir = context.dirs[area];
  const target = path.resolve(areaDir, ...parts);
  // containment
  containmentCheck(areaDir, target);
  // link escape check on existing ancestors
  const anc = nearestExistingAncestor(target);
  const ancReal = fs.realpathSync(anc);
  const areaReal = fs.realpathSync(areaDir);
  if (!isInside(areaReal, ancReal)) throw new Error('link escape rejected: ' + relative);
  // if target exists, ensure realpath inside area
  if (fs.existsSync(target)) {
    const tReal = fs.realpathSync(target);
    if (!isInside(areaReal, tReal)) throw new Error('link escape rejected: ' + relative);
    // foreign/unsafe leaf: if it's a directory when file expected? keep simple: allow
  }
  return target;
}

function contextFromEnv(env) {
  env = env || process.env;
  const val = env && env.SITE_RUN_CONTEXT;
  if (!val) return null;
  return loadRunContext(val);
}

function contextEnvironment(context, baseEnv) {
  assertRunContext(context, { writable: false });
  const out = Object.assign({}, baseEnv || {});
  out.SITE_RUN_CONTEXT = context.files.context;
  return out;
}

function sealRun(context) {
  assertRunContext(context, { writable: true });
  // validate required root artifacts
  for (const name of ROOT_ARTIFACTS) {
    const f = path.join(context.run_root, name);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
      throw new Error('missing required root artifact: ' + name);
    }
  }
  // verify identity via context file
  const stored = readJson(context.files.context);
  if (stored.site_name !== context.site_name || stored.run_id !== context.run_id) {
    throw new Error('context identity mismatch at seal');
  }
  const sealFile = context.files.seal;
  // exclusive create
  const sealObj = {
    layout_version: context.layout_version,
    site_name: context.site_name,
    run_id: context.run_id,
    run_root: context.run_root,
    sealed_at: new Date().toISOString()
  };
  writeJsonExclusive(sealFile, sealObj);
  // return new sealed context
  return makeContext(context.site_name, context.run_id, context.run_root, true);
}

module.exports = {
  LAYOUT_VERSION: LAYOUT_VERSION,
  AREAS: AREAS.slice(),
  ROOT_ARTIFACTS: ROOT_ARTIFACTS.slice(),
  createRunContext: createRunContext,
  loadRunContext: loadRunContext,
  assertRunContext: assertRunContext,
  runPath: runPath,
  contextFromEnv: contextFromEnv,
  contextEnvironment: contextEnvironment,
  sealRun: sealRun
};
module.exports.default = module.exports;
