'use strict';

/**
 * anchorSynth.js — M3 Fix B (pure, zero dependencies).
 *
 * When perception finds ZERO input-class elements but OCR still reads the
 * empty-todo placeholder anchor (needs|to-be-done|add|enter|type) in the top
 * band, synthesize one WEAK search_field from the anchor row's word boxes so
 * the executor has a real-frame target instead of unresolved_target.
 *
 *   synthAnchorInputs(elements, ocrWords, imageH) -> { elements, added }
 * - elements keeps original order; synth appended (never filtered here).
 * - anchor words: ANCHOR_RE match, center-y within TOPBAND_FRAC * imageH.
 * - row = words within ROW_DY of the anchor's center-y; box = row union
 *   padded; center is guaranteed inside the real input on the tested page.
 * - text = row words joined; tag synth:'ocr_anchor' (WEAK resolution only).
 */

const ANCHOR_RE = /\bneeds\b|\bto[-\s]?be[-\s]?done\b|\bdone\b|\badd\b|\benter\b|\btype\b/i;
const TOPBAND_FRAC = 0.4;
const ROW_DY = 12;
const PAD_X = 8;
const PAD_Y = 6;

function isInputType(type) {
  return typeof type === 'string' && /^(text_input|search_field|password|input)/.test(type);
}

function isButtonType(type) {
  return typeof type === 'string' && /button/i.test(type);
}

function hasLabelText(el) {
  return !!(el && el.text && String(el.text).trim());
}

// N7-option2 smallest-S (Q11): perceive-side label-drift proxy, behind
// opts.driftFlag (default OFF = zero behavior change). When ON, button-class
// elements with empty text get an informational WEAK-grade `drift` tag and
// the counted metric returns as `drift` (these are exactly the elements that
// force proximity-fallback clicks downstream). Resolve-side warning wiring
// in executeTests.js is deferred to that region's owner; this module only
// tags + counts. Never mutates caller-owned element objects.
function flagLabelDrift(base, want) {
  if (!want) return { elements: base, drift: 0 };
  let drift = 0;
  const out = base.map((el) => {
    if (el && isButtonType(el.type) && !hasLabelText(el)) {
      drift += 1;
      return Object.assign({}, el, { drift: 'label_absent' });
    }
    return el;
  });
  return { elements: out, drift };
}

function finish(base, added, opts) {
  const flagged = flagLabelDrift(base, !!(opts && opts.driftFlag));
  return { elements: flagged.elements, added, drift: flagged.drift };
}

function synthAnchorInputs(elements, ocrWords, imageH, opts) {
  const base = Array.isArray(elements) ? elements.slice() : [];
  if (!Array.isArray(ocrWords) || !ocrWords.length) return finish(base, 0, opts);
  if (base.some((el) => el && isInputType(el.type))) return finish(base, 0, opts);
  const h = Number(imageH);
  if (!Number.isFinite(h) || h <= 0) return finish(base, 0, opts);

  const words = ocrWords.filter((w) => w && w.bbox && Number.isFinite(w.bbox.x) &&
    Number.isFinite(w.bbox.y) && Number.isFinite(w.bbox.w) && Number.isFinite(w.bbox.h));
  // Candidate anchors in the top band; the placeholder row carries MULTIPLE
  // anchor words ("What needs to be done?") while stray sidebar words
  // ("TypeScript") carry one — score rows by anchor hits, tie-break widest.
  const cands = words.filter((w) => ANCHOR_RE.test(String(w.text || '')) &&
    (w.bbox.y + w.bbox.h / 2) < TOPBAND_FRAC * h);
  if (!cands.length) return finish(base, 0, opts);

  const rowOf = (anchor) => {
    const acy = anchor.bbox.y + anchor.bbox.h / 2;
    return words.filter((w) => Math.abs((w.bbox.y + w.bbox.h / 2) - acy) < ROW_DY)
      .sort((a, b) => a.bbox.x - b.bbox.x);
  };
  const widthOf = (row) => row.length
    ? Math.max(...row.map((w) => w.bbox.x + w.bbox.w)) - Math.min(...row.map((w) => w.bbox.x))
    : 0;
  let best = null;
  for (const anchor of cands) {
    const row = rowOf(anchor);
    const hits = row.filter((w) => ANCHOR_RE.test(String(w.text || ''))).length;
    const width = widthOf(row);
    if (!best || hits > best.hits || (hits === best.hits && width > best.width)) {
      best = { row, hits, width };
    }
  }
  const row = (best && best.row) || [];
  if (!row.length) return finish(base, 0, opts);

  const x1 = Math.max(0, Math.min(...row.map((w) => w.bbox.x)) - PAD_X);
  const y1 = Math.max(0, Math.min(...row.map((w) => w.bbox.y)) - PAD_Y);
  const x2 = Math.max(...row.map((w) => w.bbox.x + w.bbox.w)) + PAD_X;
  const y2 = Math.max(...row.map((w) => w.bbox.y + w.bbox.h)) + PAD_Y;
  if (!(x2 > x1 && y2 > y1)) return finish(base, 0, opts);
  const avgOcr = row.reduce((s, w) => s + (Number(w.conf) || 0), 0) / row.length;

  base.push({
    id: 'elem-anchor-0',
    type: 'search_field',
    yolo_label: 'OCR Anchor',
    text: row.map((w) => w.text).join(' ').trim() || null,
    bbox: { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2) },
    confidence: { yolo: 0, ocr: Math.round(avgOcr), combined: 0 },
    word_count: row.length,
    synth: 'ocr_anchor',
  });
  return finish(base, 1, opts);
}

module.exports = { synthAnchorInputs, ANCHOR_RE, TOPBAND_FRAC, ROW_DY, isButtonType, hasLabelText };
