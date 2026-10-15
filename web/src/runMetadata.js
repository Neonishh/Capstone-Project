'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const metadataPath = path.join(__dirname, '..', 'logs', 'run_metadata.json');
function parseRunArgs(args) {
  const url = args[0] || 'https://demoqa.com';
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Website URL must use HTTP or HTTPS');
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    if (!['--app', '--comparison'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || options[key]) {
      throw new Error('Usage: npm run explore -- <url> --app <app-id> --comparison <comparison-id>');
    }
    options[key] = args[i + 1].trim();
  }
  if (!options['--app'] || !options['--comparison']) throw new Error('Provide --app and --comparison for this experiment');
  return { run_id: randomUUID(), created_at: new Date().toISOString(), platform: 'web', architecture: 'A',
    app_id: options['--app'], comparison_id: options['--comparison'], url, ready: false };
}
function fingerprints() {
  return Object.fromEntries(['memory_log.json', 'test_cases.json'].map(name => [name,
    createHash('sha256').update(fs.readFileSync(path.join(path.dirname(metadataPath), name))).digest('hex')]));
}
function writeMetadata(metadata) {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}
function finishMetadata(metadata) {
  writeMetadata({ ...metadata, ready: true, fingerprints: fingerprints() });
}
function readMetadata() {
  if (!fs.existsSync(metadataPath)) throw new Error('Run exploration with --app and --comparison before executing tests');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (!metadata.ready || JSON.stringify(metadata.fingerprints) !== JSON.stringify(fingerprints())) {
    throw new Error('Exploration is incomplete or logs/cases changed. Regenerate exploration before executing.');
  }
  return metadata;
}
module.exports = { parseRunArgs, writeMetadata, finishMetadata, readMetadata };
