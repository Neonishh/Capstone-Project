'use strict';

/**
 * inputFilter.js — pure fragment filter for input-class elements (R3-T3).
 *
 * YOLO emits several overlapping boxes per real text field (saucedemo login
 * shows ~6 fragments for 2 fields). This module collapses them so the
 * candidate builder and goal planner see one element per field.
 *
 * Pure function, zero dependencies, no env/network/LLM/browser access:
 *   filterInputs(elements) -> { elements, removed }
 * `elements` keeps original order; non-input elements are never touched;
 * `removed` counts dropped input elements.
 *
 * Rules (input types: text_input | search_field | password | input*):
 *   1. NMS: pairwise IoU > INPUT_NMS_IOU keeps the higher-confidence box.
 *   2. Containment: a box >= INPUT_CONTAINMENT inside another input is
 *      dropped (ties: larger area wins, then higher conf, then lower index).
 *   3. Same row (|dCy| < INPUT_ROW_DY + x-overlap) keeps the widest box.
 *   4. Small boxes (w < INPUT_MIN_W or h < INPUT_MIN_H) are dropped, unless
 *      only one input remains (a lone small field is kept, never emptied).
 */

const DEFAULTS = {
  NMS_IOU: 0.3,
  CONTAINMENT: 0.8,
  MIN_W: 80,
  MIN_H: 18,
  ROW_DY: 12,
};

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function config() {
  return {
    NMS_IOU: numEnv('INPUT_NMS_IOU', DEFAULTS.NMS_IOU),
    CONTAINMENT: numEnv('INPUT_CONTAINMENT', DEFAULTS.CONTAINMENT),
    MIN_W: numEnv('INPUT_MIN_W', DEFAULTS.MIN_W),
    MIN_H: numEnv('INPUT_MIN_H', DEFAULTS.MIN_H),
    ROW_DY: numEnv('INPUT_ROW_DY', DEFAULTS.ROW_DY),
  };
}

function isInputType(type) {
  if (type === 'text_input' || type === 'search_field' || type === 'password') return true;
  if (type === 'contenteditable') return true;
  return typeof type === 'string' && type.indexOf('input') === 0;
}

function boxOf(el) {
  const b = el && el.bbox;
  if (!b) return null;
  const x1 = Number(b.x1);
  const y1 = Number(b.y1);
  const x2 = Number(b.x2);
  const y2 = Number(b.y2);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
      !Number.isFinite(x2) || !Number.isFinite(y2)) return null;
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

function confOf(el) {
  if (el && el.confidence && Number.isFinite(Number(el.confidence.yolo))) {
    return Number(el.confidence.yolo);
  }
  if (el && Number.isFinite(Number(el.conf))) return Number(el.conf);
  return 0;
}

function area(b) {
  return (b.x2 - b.x1) * (b.y2 - b.y1);
}

function interArea(a, b) {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  return (ix2 - ix1) * (iy2 - iy1);
}

function iou(a, b) {
  const inter = interArea(a, b);
  if (!inter) return 0;
  return inter / (area(a) + area(b) - inter);
}

function filterInputs(elements) {
  if (!Array.isArray(elements)) return { elements: [], removed: 0 };
  const cfg = config();
  const indexed = elements.map((el, i) => ({ el, i }));
  const inputs = indexed.filter(
    ({ el }) => isInputType(el && el.type) && boxOf(el) !== null
  );
  if (!inputs.length) return { elements: elements.slice(), removed: 0 };

  const keep = new Set(inputs.map((x) => x.i));
  const boxes = new Map(inputs.map((x) => [x.i, boxOf(x.el)]));
  const confs = new Map(inputs.map((x) => [x.i, confOf(x.el)]));
  const drop = (i) => keep.delete(i);

  // 1. Greedy NMS over input boxes (highest confidence first).
  const byConf = [...inputs].sort((a, b) => confs.get(b.i) - confs.get(a.i) || a.i - b.i);
  const nmsKept = [];
  for (const c of byConf) {
    if (!keep.has(c.i)) continue;
    let suppressed = false;
    for (const k of nmsKept) {
      if (iou(boxes.get(c.i), boxes.get(k)) > cfg.NMS_IOU) {
        suppressed = true;
        break;
      }
    }
    if (suppressed) drop(c.i);
    else nmsKept.push(c.i);
  }

  // 2. Containment: a box mostly inside another input goes.
  for (const a of inputs) {
    if (!keep.has(a.i)) continue;
    const ba = boxes.get(a.i);
    for (const b of inputs) {
      if (a.i === b.i || !keep.has(b.i)) continue;
      const bb = boxes.get(b.i);
      if (interArea(ba, bb) / area(ba) >= cfg.CONTAINMENT) {
        const areaA = area(ba);
        const areaB = area(bb);
        const bWins = areaB > areaA ||
          (areaB === areaA && (confs.get(b.i) > confs.get(a.i) ||
            (confs.get(b.i) === confs.get(a.i) && b.i < a.i)));
        if (bWins) {
          drop(a.i);
          break;
        }
      }
    }
  }

  // 3. Same-row fragments (|dCy| + x-overlap): keep the widest.
  const survivors = inputs.filter((x) => keep.has(x.i));
  const width = (x) => {
    const b = boxes.get(x.i);
    return b.x2 - b.x1;
  };
  const byWidth = [...survivors].sort(
    (a, b) => width(b) - width(a) || confs.get(b.i) - confs.get(a.i) || a.i - b.i
  );
  const rowKept = [];
  for (const c of byWidth) {
    const bc = boxes.get(c.i);
    const cy = (bc.y1 + bc.y2) / 2;
    let clash = false;
    for (const k of rowKept) {
      const bk = boxes.get(k);
      const ky = (bk.y1 + bk.y2) / 2;
      if (Math.abs(cy - ky) < cfg.ROW_DY && bc.x1 < bk.x2 && bk.x1 < bc.x2) {
        clash = true;
        break;
      }
    }
    if (clash) drop(c.i);
    else rowKept.push(c.i);
  }

  // 4. Small boxes go, unless a single input would remain.
  const left = inputs.filter((x) => keep.has(x.i));
  if (left.length > 1) {
    for (const x of left) {
      const b = boxes.get(x.i);
      if (b.x2 - b.x1 < cfg.MIN_W || b.y2 - b.y1 < cfg.MIN_H) drop(x.i);
    }
  }

  const dropped = inputs.filter((x) => !keep.has(x.i)).length;
  const out = elements.filter((el, i) => {
    if (!isInputType(el && el.type)) return true;
    if (boxOf(el) === null) return true;
    return keep.has(i);
  });
  return { elements: out, removed: dropped };
}

module.exports = { filterInputs, isInputType, DEFAULTS };
