'use strict';

/**
 * explorer.js — autonomous multi-page visual exploration for Architecture B.
 *
 * Starts from one URL and repeatedly:
 *   capture screenshot -> YOLO+OCR+merge (gateway) -> candidate actions
 *   -> LLM selects ONE action from the CURRENT state's candidate table
 *   -> Playwright executes it -> post-action screenshot -> re-detect
 *   -> fingerprint new state -> repeated? go back : adopt as current state
 *
 * Guarantees:
 *   - coordinates ALWAYS come from the freshly detected visual DOM of the
 *     state the action is taken in (the LLM only picks an element id;
 *     it can never supply stale or invented coordinates)
 *   - every state records url + normalized-text hash + element-signature hash
 *   - repeated states are skipped (action marked tried, browser goes back)
 *   - hard limits guarantee termination
 *
 * Outputs (per run_id):
 *   storage/screenshots/<run_id>/state_NNN_*.png   evidence
 *   storage/outputs/<run_id>_exploration_history.json
 *   storage/outputs/<run_id>_exploration_result.json
 *   storage/outputs/test_cases_<run_id>_exploration.json  (replayable workflows)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { chromium } = require('playwright');
const { callLLM, extractJSON } = require('./llm');

const VISION_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(VISION_ROOT, 'storage', 'outputs');
const SCREENSHOT_ROOT = path.join(VISION_ROOT, 'storage', 'screenshots');
const GATEWAY_URL = process.env.VISION_GATEWAY_URL || 'http://127.0.0.1:5000';
const YOLO_URL = process.env.YOLO_SERVICE_URL || 'http://127.0.0.1:5001';
const VIEWPORT = { width: 1280, height: 900 };

// Configurable exploration limits.
const LIMITS = {
  MAX_STEPS: Number(process.env.EXPLORE_MAX_STEPS) || 25,
  MAX_DEPTH: Number(process.env.EXPLORE_MAX_DEPTH) || 8,
  MAX_STATES: Number(process.env.EXPLORE_MAX_STATES) || 12,
  MAX_ACTIONS_PER_STATE: Number(process.env.EXPLORE_MAX_ACTIONS_PER_STATE) || 4,
};

const CANDIDATE_TYPES = new Set([
  'button', 'link', 'text_input', 'select', 'checkbox', 'radiobox',
  'tab', 'menu', 'list_item', 'search_field', 'bottom_navigation',
]);
const ACTION_TYPES = new Set(['click', 'fill', 'scroll', 'navigate', 'submit', 'done']);

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function redetect(imagePath) {
  const res = await axios.post(
    `${GATEWAY_URL}/vision/process`,
    { image_path: imagePath },
    { timeout: 90000 }
  );
  return res.data;
}

async function renderMergedEvidence(absShot, elements) {
  try {
    const annotations = (elements || []).slice(0, 60).map((el) => ({
      bbox: [el.bbox.x1, el.bbox.y1, el.bbox.x2, el.bbox.y2],
      lines: [`${el.type} ${el.id}`, el.text || ''],
      color: [255, 200, 0],
    }));
    const res = await axios.post(
      `${YOLO_URL}/render_boxes`,
      { image_path: absShot, annotations },
      { timeout: 30000 }
    );
    return res.data.annotated_image_b64 || null;
  } catch {
    return null;
  }
}

function tier(conf) {
  if (conf >= 0.6) return 'HIGH';
  if (conf >= 0.3) return 'MEDIUM';
  return 'LOW';
}

/** Candidate action table from the CURRENT visual DOM only. */
function buildCandidates(vdom, triedKeys, failCounts) {
  const list = (vdom.elements || [])
    .filter((el) => CANDIDATE_TYPES.has(el.type))
    .filter((el) => !(el.confidence && el.confidence.yolo < 0.3 && !el.text)) // LOW without OCR text excluded
    .map((el) => {
      const x = Math.round((el.bbox.x1 + el.bbox.x2) / 2);
      const y = Math.round((el.bbox.y1 + el.bbox.y2) / 2);
      const familyKey = `${el.type}|${normText(el.text)}`;
      return {
        elementId: el.id,
        type: el.type,
        text: (el.text || '').slice(0, 40),
        conf: el.confidence ? Number(el.confidence.yolo.toFixed(2)) : null,
        tier: tier(el.confidence ? el.confidence.yolo : 0),
        x, y,
        alreadyTried: triedKeys.has(`${el.type}|${normText(el.text)}|${x},${y}`),
        // Elements whose (type,text) family repeatedly failed exploration
        // (repeated/invalid outcomes) are excluded across ALL pages.
        familyFailures: failCounts.get(familyKey) || 0,
        _key: `${el.type}|${normText(el.text)}|${x},${y}`,
      };
    })
    .filter((c) => c.tier !== 'LOW' || c.text)
    .filter((c) => c.familyFailures < 2);

  const rank = { HIGH: 0, MEDIUM: 1 };
  list.sort((a, b) => (rank[a.tier] - rank[b.tier]) || a.alreadyTried - b.alreadyTried);
  return list.slice(0, 15);
}

async function selectActionLLM(candidates, contextSummary) {
  const candidateTable = JSON.stringify(
    candidates.map(({ _key, ...rest }) => rest), null, 2);

  const buildPrompt = (forbidDone) => `You are an autonomous visual web-exploration agent. Below are the interactive elements DETECTED ON THE CURRENT SCREEN (YOLO + OCR). Choose exactly ONE next action.

CURRENT SCREEN CANDIDATES (elementId, type, text, confidence tier, centre coordinates, alreadyTried):
${candidateTable}

EXPLORATION CONTEXT:
${contextSummary}

RULES:
1. Coordinates are FIXED by the table — choose an elementId; never invent coordinates.
2. Prefer elements with alreadyTried=false. NEVER repeat an alreadyTried element on this screen unless nothing else remains.
3. "fill": pick a text input; value must match its placeholder/label meaning.
4. Links/buttons labelled like site sections usually navigate (good for exploring NEW pages).
5. Use "scroll" when content below the fold is plausible and few unexplored candidates remain.
6. Choose "done" ONLY when no unexplored meaningful action remains.${forbidDone ? '\n7. IMPORTANT: untried candidates ARE available — "done" is NOT acceptable right now. Pick one untried element.' : ''}
8. Respond ONLY with raw JSON: {"action":"click"|"fill"|"scroll"|"navigate"|"submit"|"done","elementId":"<id from table or null>","value":"<text for fill>","reason":"<one sentence>"}`;

  const decide = async (forbidDone) => {
    const raw = await callLLM(buildPrompt(forbidDone), { maxTokens: 400 });
    let obj = typeof raw === 'string' ? extractJSON(raw) : raw;
    if (!obj || typeof obj !== 'object') obj = {};
    let action = String(obj.action || '').toLowerCase();
    if (!ACTION_TYPES.has(action)) action = 'done';
    const chosen = candidates.find((c) => c.elementId === obj.elementId)
      || candidates.find((c) => normText(c.text) && obj.value && normText(c.text).includes(normText(obj.value)));
    return {
      action,
      candidate: action === 'click' || action === 'fill' || action === 'submit' ? chosen || null : null,
      value: typeof obj.value === 'string' ? obj.value : '',
      reason: typeof obj.reason === 'string' ? obj.reason : '',
    };
  };

  const first = await decide(false);
  // Anti-laziness guard: refuse "done" while untried candidates remain.
  if (first.action === 'done' && candidates.some((c) => !c.alreadyTried)) {
    console.log('[explore] LLM said done but untried candidates remain — reprompting.');
    return decide(true);
  }
  return first;
}

/** Replayable workflow paths recovered from the recorded state tree. */
function workflowsFromStates(states) {
  const byId = new Map(states.map((s) => [s.state_id, s]));
  const children = new Map();
  for (const s of states) {
    if (!s.parent_state_id) continue;
    if (!children.has(s.parent_state_id)) children.set(s.parent_state_id, []);
    children.get(s.parent_state_id).push(s.state_id);
  }
  const leaves = states.filter((s) => !children.has(s.state_id) && s.parent_state_id);
  const paths = [];
  for (const leaf of leaves) {
    const chain = [];
    let cur = leaf;
    while (cur && cur.parent_state_id) {
      chain.unshift(cur.leading_action);
      cur = byId.get(cur.parent_state_id);
    }
    if (chain.length >= 2) paths.push(chain.slice(0, 10));
  }
  // Deduplicate identical step sequences.
  const seen = new Set();
  return paths.filter((p) => {
    const k = JSON.stringify(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function runExploration({ url, runId }) {
  runId = runId || `run_${Date.now()}`;
  const runDirAbs = path.join(SCREENSHOT_ROOT, runId);
  const relDir = path.join('storage', 'screenshots', runId);
  fs.mkdirSync(runDirAbs, { recursive: true });

  const startedAt = Date.now();
  const states = [];
  const transitions = [];
  const warnings = [];
  const visitedFingerprints = new Map(); // fingerprint -> state_id
  const triedActions = new Set();         // `${fingerprint}|${type}|${x},${y}`
  const actionsPerState = new Map();      // fingerprint -> count
  const failCounts = new Map();           // `${type}|${normText}` -> failed outcome count

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });
  let stateCounter = 0;

  const nextStateName = (suffix) =>
    path.join(relDir, `state_${String(++stateCounter).padStart(3, '0')}_${suffix}.png`);

  async function captureState(label, leadingAction, parentId) {
    const shotRel = nextStateName(label);
    const shotAbs = path.join(VISION_ROOT, shotRel);
    await page.screenshot({ path: shotAbs });
    const vdom = await redetect(shotAbs);
    const visibleText = await page.evaluate(() =>
      (document.body ? document.body.innerText : '').slice(0, 4000)).catch(() => '');
    const elemSig = (vdom.elements || [])
      .map((e) => `${e.type}:${normText(e.text)}`)
      .sort()
      .join('|');
    const fingerprint = `${page.url()}|${hashStr(normText(visibleText))}|${hashStr(elemSig)}`;
    const mergedB64 = await renderMergedEvidence(shotAbs, vdom.elements);
    if (mergedB64) {
      try { fs.writeFileSync(shotAbs.replace(/\.png$/, '_merged.png'), Buffer.from(mergedB64, 'base64')); } catch (_) {}
    }
    const state = {
      state_id: `state_${String(stateCounter).padStart(3, '0')}`,
      parent_state_id: parentId || null,
      url: page.url(),
      screenshot: shotRel.replace(/\\/g, '/'),
      merged_evidence: mergedB64 ? shotRel.replace(/\\/g, '/').replace(/\.png$/, '_merged.png') : null,
      yolo_detections: vdom.raw?.yolo_detections ?? null,
      ocr_words: vdom.raw?.ocr_words_found ?? null,
      element_count: vdom.element_count ?? null,
      fingerprint,
      leading_action: leadingAction || null,
      timestamp: new Date().toISOString(),
    };
    return { state, vdom, fingerprint };
  }

  let terminationReason = 'max_steps_reached';
  let current = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.setViewportSize(VIEWPORT).catch(() => {});
    await page.waitForTimeout(2000);

    current = await captureState('initial', null, null);
    visitedFingerprints.set(current.fingerprint, current.state.state_id);
    states.push(current.state);
    console.log(`[explore] ${current.state.state_id} @ ${current.state.url} (${current.state.element_count} elements)`);

    let depthOfCurrent = 0;

    while (states.length < LIMITS.MAX_STATES && transitions.length < LIMITS.MAX_STEPS) {
      if (depthOfCurrent >= LIMITS.MAX_DEPTH) {
        terminationReason = 'max_depth_reached';
        break;
      }
      const fp = current.fingerprint;
      const usedCount = actionsPerState.get(fp) || 0;
      if (usedCount >= LIMITS.MAX_ACTIONS_PER_STATE) {
        terminationReason = 'max_actions_per_state_reached';
        break;
      }

      const candidates = buildCandidates(current.vdom, triedActions, failCounts);
      if (!candidates.length) {
        terminationReason = 'no_candidates_remaining';
        break;
      }

      const historySummary =
        `Visited URLs so far: ${[...new Set(states.map((s) => s.url))].join(', ')}. ` +
        `Unique states: ${states.length}. Last actions: ` +
        transitions.slice(-4).map((t) => `${t.action.action}@${t.from_state}->${t.result}`).join('; ');

      let decision;
      try {
        decision = await selectActionLLM(candidates, historySummary);
      } catch (err) {
        // One transient retry; a dead LLM ends exploration gracefully.
        try {
          await new Promise((r) => setTimeout(r, 2500));
          decision = await selectActionLLM(candidates, historySummary);
        } catch (err2) {
          terminationReason = `llm_error: ${err2.message}`;
          warnings.push(`Action selection failed: ${err2.message}`);
          break;
        }
      }
      if (decision.action === 'done' || !decision.candidate) {
        terminationReason = decision.action === 'done'
          ? 'llm_done'
          : 'no_valid_candidate_selected';
        break;
      }

      const cand = decision.candidate;
      const execAction = {
        action: decision.action === 'submit' ? 'click' : decision.action,
        x: cand.x, y: cand.y, value: decision.value,
      };
      triedActions.add(`${fp}|${cand._key}`);
      actionsPerState.set(fp, usedCount + 1);

      const transition = {
        from_state: current.state.state_id,
        from_fingerprint: fp,
        action: {
          type: decision.action,
          elementId: cand.elementId,
          elementType: cand.type,
          elementText: cand.text,
          x: cand.x, y: cand.y,
          value: decision.value || null,
          reason: decision.reason,
        },
        result: 'executed',
        timestamp: new Date().toISOString(),
      };

      const { executeAction } = require('./llm');
      let actionError = null;
      try {
        await executeAction(page, execAction);
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        // Give SPA/router navigation a fair chance before fingerprinting.
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1500);
      } catch (err) {
        actionError = err.message;
      }

      if (actionError) {
        transition.result = 'error';
        transition.error = actionError;
        transitions.push(transition);
        warnings.push(`Step from ${transition.from_state}: ${actionError}`);
        console.log(`[explore] ${transition.from_state} --${decision.action}--> ERROR (${actionError})`);
        continue;
      }

      const recordFailure = (weight) => {
        const fam = `${cand.type}|${normText(cand.text)}`;
        failCounts.set(fam, (failCounts.get(fam) || 0) + (weight || 1));
      };

      const next = await captureState(`after_${decision.action}`, {
        action: decision.action,
        elementId: cand.elementId,
        elementType: cand.type,
        elementText: cand.text,
        x: cand.x, y: cand.y,
        value: decision.value || null,
      }, current.state.state_id);

      transition.to_state = next.state.state_id;
      transition.url_after = next.state.url;
      transition.state_similarity = {
        same_url: next.state.url === current.state.url,
        repeated_fingerprint: visitedFingerprints.has(next.fingerprint),
      };

      if (!/^https?:/i.test(next.state.url)) {
        // Non-web destinations (about:blank, error pages, external app handlers)
        // are dead ends — reject them like repeated states.
        transition.result = 'invalid_state_skipped';
        transition.url_after = next.state.url;
        transitions.push(transition);
        recordFailure(2); // non-http destination = definitive dead end
        warnings.push(`Rejected non-http destination ${next.state.url} after ${decision.action}`);
        console.log(`[explore] ${transition.from_state} --${decision.action}--> non-http state rejected, going back`);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1000);
        continue;
      }

      if (visitedFingerprints.has(next.fingerprint)) {
        transition.result = 'repeated_state_skipped';
        transitions.push(transition);
        // A click that produced NO change at all (same URL, same fingerprint)
        // is a strong junk/broken-control signal; a navigation elsewhere that
        // landed somewhere already visited is weaker (could be timing noise).
        recordFailure(transition.state_similarity.same_url ? 2 : 1);
        console.log(`[explore] ${transition.from_state} --${decision.action}--> repeated state, going back`);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1000);
        continue; // stay on the same visual state; candidate now marked tried
      }

      visitedFingerprints.set(next.fingerprint, next.state.state_id);
      states.push(next.state);
      transitions.push(transition);
      depthOfCurrent += 1;
      current = next;
      console.log(
        `[explore] ${transition.from_state} --${decision.action}(${cand.type}:${cand.text || ''})--> ` +
        `${next.state.state_id} @ ${next.state.url}`
      );
    }

    if (states.length >= LIMITS.MAX_STATES) terminationReason = 'max_states_reached';
    if (transitions.length >= LIMITS.MAX_STEPS) terminationReason = 'max_steps_reached';
  } catch (err) {
    terminationReason = `fatal_error: ${err.message}`;
    warnings.push(err.message);
  } finally {
    await browser.close().catch(() => {});
  }

  // ------------------------------------------------------------------
  // Generate replayable multi-step test cases from ACTUAL discovered paths.
  // ------------------------------------------------------------------
  const workflows = workflowsFromStates(states);
  const testCases = workflows.map((steps, i) => ({
    id: `TC${String(i + 1).padStart(2, '0')}`,
    objective: 'Replays an autonomously discovered visual workflow: '
      + steps.map((s) => `${s.action}${s.elementText ? `(${s.elementText})` : ''}`).join(' -> '),
    evidence: [`discovered during exploration run ${runId}`],
    inferred_behavior: 'Recorded sequence of real executed actions',
    steps: steps.map((s) => ({
      action: s.action === 'navigate' ? 'navigate' : s.action,
      x: ['click', 'fill'].includes(s.action) ? s.x : null,
      y: ['click', 'fill'].includes(s.action) ? s.y : null,
      value: s.value || '',
      // Target hint so replay can re-resolve on the CURRENT visual state.
      ...(s.elementType || s.elementText ? {
        target: { type: s.elementType || '', text: s.elementText || '' },
      } : {}),
      ...(s.action === 'navigate' && s.url ? { url: s.url } : {}),
    })),
    expected_result: 'All recorded actions execute without errors and the final page renders non-trivially.',
    expect_navigation: false,
    expected_text: null,
  }));
  const tcPath = path.join(OUTPUT_DIR, `test_cases_${runId}_exploration.json`);
  fs.writeFileSync(tcPath, JSON.stringify(testCases, null, 2));

  const result = {
    run_id: runId,
    start_url: url,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    limits: LIMITS,
    termination_reason: terminationReason,
    totals: {
      total_steps: transitions.length,
      total_states: states.length,
      unique_states: visitedFingerprints.size,
      unique_urls: new Set(states.map((s) => s.url)).size,
      repeated_states_skipped: transitions.filter((t) => t.result === 'repeated_state_skipped').length,
      action_errors: transitions.filter((t) => t.result === 'error').length,
      click_actions: transitions.filter((t) => ['click', 'submit'].includes(t.action.type)).length,
      fill_actions: transitions.filter((t) => t.action.type === 'fill').length,
      scroll_actions: transitions.filter((t) => t.action.type === 'scroll').length,
      submit_actions: transitions.filter((t) => t.action.type === 'submit').length,
      generated_tests: testCases.length,
      avg_steps_per_test: testCases.length
        ? Number((testCases.reduce((n, t) => n + t.steps.length, 0) / testCases.length).toFixed(2))
        : 0,
    },
    visited_urls: [...new Set(states.map((s) => s.url))],
    screenshots_dir: relDir.replace(/\\/g, '/'),
    test_cases_file: tcPath,
    warnings,
    states,
    transitions,
  };

  fs.writeFileSync(path.join(OUTPUT_DIR, `${runId}_exploration_history.json`), JSON.stringify(result, null, 2));
  const slim = { ...result, states: undefined, transitions: undefined };
  fs.writeFileSync(path.join(OUTPUT_DIR, `${runId}_exploration_result.json`), JSON.stringify(slim, null, 2));

  return result;
}

module.exports = { runExploration };
