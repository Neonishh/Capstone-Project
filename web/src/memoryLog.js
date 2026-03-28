/**
 * memoryLog.js
 * Day 1 – Nidhi K
 * Responsibility: In-memory log management for exploration steps.
 * storeStep() appends a step entry; saveLog() writes the full log to JSON.
 *
 * Schema per entry:
 * {
 *   step: number,
 *   from_url: string,
 *   from_title: string,
 *   action: 'click' | 'fill' | 'navigate',
 *   target: string,           // element tag name or URL
 *   target_element_details: {
 *     elementId: number,
 *     tag: string,
 *     text: string,
 *     id: string | null,
 *     class: string,
 *     selector: string
 *   },
 *   to_url: string,
 *   to_title: string,
 *   screenshot_before: string,   // relative path
 *   screenshot_after: string,    // relative path
 *   timestamp: string            // ISO 8601
 * }
 */

const fs = require('fs');
const path = require('path');

/**
 * storeStep(logArray, stepData)
 * Pushes a validated step entry into the in-memory log array.
 *
 * @param {Array} logArray        - The shared in-memory log array
 * @param {Object} stepData       - Raw step data object (see schema above)
 * @returns {void}
 */
function storeStep(logArray, stepData) {
  if (!Array.isArray(logArray)) {
    throw new TypeError('logArray must be an array');
  }

  // Normalise + validate required fields with safe defaults
  const entry = {
    step: typeof stepData.step === 'number' ? stepData.step : logArray.length,
    from_url: stepData.from_url || '',
    from_title: stepData.from_title || '',
    action: stepData.action || 'unknown',
    target: stepData.target || '',
    target_element_details: stepData.target_element_details
      ? {
          elementId: stepData.target_element_details.elementId ?? null,
          tag: stepData.target_element_details.tag || '',
          text: stepData.target_element_details.text || '',
          id: stepData.target_element_details.id || null,
          class: stepData.target_element_details.class || stepData.target_element_details.className || '',
          selector: stepData.target_element_details.selector || '',
        }
      : null,
    to_url: stepData.to_url || '',
    to_title: stepData.to_title || '',
    screenshot_before: stepData.screenshot_before || '',
    screenshot_after: stepData.screenshot_after || '',
    timestamp: stepData.timestamp || new Date().toISOString(),
  };

  logArray.push(entry);
}

/**
 * saveLog(logArray, filePath)
 * Serialises the full log array to a JSON file.
 * Creates parent directories if they don't exist.
 *
 * @param {Array}  logArray  - The in-memory log array
 * @param {string} filePath  - Destination file path (e.g. 'logs/memory_log.json')
 * @returns {void}
 */
function saveLog(logArray, filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(logArray, null, 2), 'utf8');
  console.log(`[memoryLog] Saved ${logArray.length} step(s) → ${filePath}`);
}

/**
 * loadLog(filePath)
 * Reads and parses an existing memory_log.json file.
 * Returns empty array if file does not exist.
 *
 * @param {string} filePath
 * @returns {Array}
 */
function loadLog(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[memoryLog] Failed to load ${filePath}:`, err.message);
    return [];
  }
}

module.exports = { storeStep, saveLog, loadLog };
