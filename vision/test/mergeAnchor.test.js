'use strict';

// M3 empty-input-recall: offline tests for the OCR-anchor synth (Fix B).
// Pure helper, no services, no browser, no network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { synthAnchorInputs } = require('../src/anchorSynth');

const word = (text, x, y, w = 60, h = 17, conf = 95) => ({ text, conf, bbox: { x, y, w, h } });
const link = (id, x1 = 10, y1 = 500) => ({ id, type: 'link', text: 'x', bbox: { x1, y1, x2: x1 + 50, y2: y1 + 15 } });

test('M3 Fix B: zero inputs + topband anchor -> one WEAK ocr_anchor search_field', () => {
  const elements = [link('elem-0'), link('elem-1')];
  const ocr = [
    word('What', 578, 153), word('needs', 639, 153), word('done?', 771, 153),
    word('footer', 20, 800),
  ];
  const { elements: out, added } = synthAnchorInputs(elements, ocr, 900);
  assert.equal(added, 1);
  assert.equal(out.length, 3);
  const synth = out[2];
  assert.equal(synth.type, 'search_field');
  assert.equal(synth.synth, 'ocr_anchor');
  assert.match(synth.text, /needs/i);
  const cx = (synth.bbox.x1 + synth.bbox.x2) / 2;
  const cy = (synth.bbox.y1 + synth.bbox.y2) / 2;
  assert.ok(cx > 500 && cx < 900, 'anchor center sits over the real input band');
  assert.ok(cy > 100 && cy < 220, 'anchor center sits in the top band');
});

test('M3 Fix B: sidebar stray word (TypeScript) must not beat the placeholder row', () => {
  const elements = [link('elem-0')];
  const ocr = [
    word('TypeScript', 18, 116, 66, 13, 78),
    word('What', 578, 153), word('needs', 639, 153), word('done?', 771, 153),
  ];
  const { elements: out, added } = synthAnchorInputs(elements, ocr, 900);
  assert.equal(added, 1);
  assert.match(out[1].text, /needs/i);
  const cx = (out[1].bbox.x1 + out[1].bbox.x2) / 2;
  assert.ok(cx > 500, 'synth centers on the placeholder row, not the sidebar');
});

test('M3 Fix B: no synth when inputs exist, no anchor, or bad height', () => {
  const ocr = [word('needs', 639, 153), word('done?', 771, 153)];
  const withInput = [{ id: 'e', type: 'text_input', bbox: { x1: 1, y1: 1, x2: 9, y2: 9 } }];
  assert.equal(synthAnchorInputs(withInput, ocr, 900).added, 0);
  assert.equal(synthAnchorInputs([link('a')], [word('footer', 20, 800)], 900).added, 0);
  assert.equal(synthAnchorInputs([link('a')], ocr, 0).added, 0);
  assert.equal(synthAnchorInputs([link('a')], [], 900).added, 0);
  // Anchor below the top band (y 500 of 900) is ignored.
  assert.equal(synthAnchorInputs([link('a')], [word('needs', 100, 500)], 900).added, 0);
});
