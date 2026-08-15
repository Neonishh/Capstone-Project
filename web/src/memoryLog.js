'use strict';

/**
 * memoryLog.js
 *
 * Responsibility:
 *
 *   Store raw evidence produced during autonomous browser exploration.
 *
 * This file intentionally does NOT:
 *   - summarize flows
 *   - interpret website functionality
 *   - generate test cases
 *   - call the LLM
 *
 * Those responsibilities belong to later stages of the pipeline.
 *
 * Pipeline:
 *
 *   Playwright
 *       |
 *       v
 *   memoryLog.js
 *       |
 *       v
 *   contextBuilder.js
 *       |
 *       v
 *   testGenerator.js
 */


const fs = require('fs');
const path = require('path');


// ============================================================================
// STORE STEP
// ============================================================================

/**
 * storeStep(logArray, stepData)
 *
 * Adds one raw exploration event to the in-memory log.
 *
 * The function normalizes the structure so that every log entry follows
 * the same schema.
 */
function storeStep(logArray, stepData = {}) {

  if (!Array.isArray(logArray)) {
    throw new TypeError(
      'storeStep: logArray must be an array'
    );
  }


  // --------------------------------------------------------------------------
  // Normalize target element information.
  // --------------------------------------------------------------------------

  const targetElement =
    normalizeElement(
      stepData.target_element_details
    );


  // --------------------------------------------------------------------------
  // Normalize action.
  // --------------------------------------------------------------------------

  const action =
    typeof stepData.action === 'string'
      ? stepData.action.trim().toLowerCase()
      : 'unknown';


  // --------------------------------------------------------------------------
  // Build the raw event.
  // --------------------------------------------------------------------------

  const entry = {

    // Sequential exploration step.
    step:
      Number.isInteger(stepData.step)
        ? stepData.step
        : logArray.length,


    // Which flow was being explored.
    flow_name:
      typeof stepData.flow_name === 'string'
        ? stepData.flow_name
        : '',


    // Planning cycle that produced the action.
    planning_cycle:
      Number.isInteger(stepData.planning_cycle)
        ? stepData.planning_cycle
        : null,


    // Browser state before the action.
    from_url:
      typeof stepData.from_url === 'string'
        ? stepData.from_url
        : '',

    from_title:
      typeof stepData.from_title === 'string'
        ? stepData.from_title
        : '',


    // Action selected by the LLM.
    action,


    // Human-readable target.
    target:
      typeof stepData.target === 'string'
        ? stepData.target
        : '',


    // Full DOM information for the selected element.
    target_element_details:
      targetElement,


    // Value entered into an input, if applicable.
    value:
      typeof stepData.value === 'string'
        ? stepData.value
        : '',


    // Browser state after the action.
    to_url:
      typeof stepData.to_url === 'string'
        ? stepData.to_url
        : '',

    to_title:
      typeof stepData.to_title === 'string'
        ? stepData.to_title
        : '',


    // Whether Playwright successfully executed the action.
    success:
      stepData.success !== false,


    // Execution error, if any.
    error:
      typeof stepData.error === 'string'
        ? stepData.error
        : '',


    // LLM's explanation for choosing this action.
    reason:
      typeof stepData.reason === 'string'
        ? stepData.reason
        : '',


    // Screenshots are currently disabled for the DOM experiment.
    //
    // These fields are retained because the same memory schema can later
    // support the vision-based YOLO + OCR experiment.
    screenshot_before:
      typeof stepData.screenshot_before === 'string'
        ? stepData.screenshot_before
        : '',

    screenshot_after:
      typeof stepData.screenshot_after === 'string'
        ? stepData.screenshot_after
        : '',


    // Timestamp of the event.
    timestamp:
      typeof stepData.timestamp === 'string'
        ? stepData.timestamp
        : new Date().toISOString()
  };


  logArray.push(entry);

  return entry;
}


// ============================================================================
// NORMALIZE ELEMENT
// ============================================================================

/**
 * normalizeElement(element)
 *
 * Keeps the useful DOM information associated with the action.
 *
 * The entire DOM inventory is NOT stored here.
 *
 * We only store the element that the LLM actually selected.
 */
function normalizeElement(element) {

  if (
    !element ||
    typeof element !== 'object'
  ) {
    return null;
  }


  return {

    elementId:
      Number.isInteger(element.elementId)
        ? element.elementId
        : null,


    tag:
      typeof element.tag === 'string'
        ? element.tag
        : '',


    role:
      typeof element.role === 'string'
        ? element.role
        : '',


    text:
      typeof element.text === 'string'
        ? element.text
        : '',


    label:
      typeof element.label === 'string'
        ? element.label
        : '',


    id:
      typeof element.id === 'string'
        ? element.id
        : null,


    className:
      typeof element.className === 'string'
        ? element.className
        : '',


    selector:
      typeof element.selector === 'string'
        ? element.selector
        : '',


    href:
      typeof element.href === 'string'
        ? element.href
        : '',


    inputType:
      typeof element.inputType === 'string'
        ? element.inputType
        : '',


    placeholder:
      typeof element.placeholder === 'string'
        ? element.placeholder
        : '',


    ariaLabel:
      typeof element.ariaLabel === 'string'
        ? element.ariaLabel
        : '',


    ariaExpanded:
      element.ariaExpanded ?? null,


    ariaChecked:
      element.ariaChecked ?? null,


    ariaSelected:
      element.ariaSelected ?? null,


    name:
      typeof element.name === 'string'
        ? element.name
        : null,


    disabled:
      element.disabled === true,


    required:
      element.required === true,


    contentEditable:
      element.contentEditable === true,


    checked:
      typeof element.checked === 'boolean'
        ? element.checked
        : null,


    selected:
      typeof element.selected === 'boolean'
        ? element.selected
        : null,


    // We don't need to persist the current input value from the DOM
    // because the action's actual value is stored separately.
    inputValue:
      typeof element.value === 'string'
        ? element.value
        : '',


    // Useful later for comparing DOM and vision-based detection.
    boundingBox:
      normalizeBoundingBox(
        element.boundingBox
      )
  };
}


// ============================================================================
// NORMALIZE BOUNDING BOX
// ============================================================================

function normalizeBoundingBox(box) {

  if (
    !box ||
    typeof box !== 'object'
  ) {
    return null;
  }


  return {

    x:
      Number.isFinite(box.x)
        ? box.x
        : 0,

    y:
      Number.isFinite(box.y)
        ? box.y
        : 0,

    width:
      Number.isFinite(box.width)
        ? box.width
        : 0,

    height:
      Number.isFinite(box.height)
        ? box.height
        : 0
  };
}


// ============================================================================
// SAVE LOG
// ============================================================================

/**
 * saveLog(logArray, filePath)
 *
 * Writes the complete raw exploration log to disk.
 */
function saveLog(logArray, filePath) {

  if (!Array.isArray(logArray)) {
    throw new TypeError(
      'saveLog: logArray must be an array'
    );
  }


  if (
    typeof filePath !== 'string' ||
    filePath.trim() === ''
  ) {
    throw new TypeError(
      'saveLog: filePath must be a non-empty string'
    );
  }


  const directory =
    path.dirname(filePath);


  if (
    !fs.existsSync(directory)
  ) {
    fs.mkdirSync(
      directory,
      {
        recursive: true
      }
    );
  }


  fs.writeFileSync(
    filePath,
    JSON.stringify(
      logArray,
      null,
      2
    ),
    'utf8'
  );


  console.log(
    `[memoryLog] Saved ${logArray.length} step(s) → ${filePath}`
  );
}


// ============================================================================
// LOAD LOG
// ============================================================================

/**
 * loadLog(filePath)
 *
 * Loads a previously saved exploration log.
 *
 * Returns [] when:
 *   - the file doesn't exist
 *   - the file is invalid
 */
function loadLog(filePath) {

  if (
    typeof filePath !== 'string' ||
    filePath.trim() === ''
  ) {
    return [];
  }


  if (
    !fs.existsSync(filePath)
  ) {
    return [];
  }


  try {

    const raw =
      fs.readFileSync(
        filePath,
        'utf8'
      );


    const parsed =
      JSON.parse(raw);


    if (!Array.isArray(parsed)) {

      console.error(
        '[memoryLog] Memory log is not an array.'
      );

      return [];
    }


    return parsed;

  } catch (err) {

    console.error(
      `[memoryLog] Failed to load ${filePath}:`,
      err.message
    );

    return [];
  }
}


// ============================================================================
// CLEAR LOG
// ============================================================================

/**
 * clearLog(filePath)
 *
 * Removes an existing memory log.
 *
 * This is useful when starting a completely new website exploration.
 */
function clearLog(filePath) {

  if (
    typeof filePath !== 'string' ||
    filePath.trim() === ''
  ) {
    return;
  }


  if (
    fs.existsSync(filePath)
  ) {

    fs.unlinkSync(
      filePath
    );

    console.log(
      `[memoryLog] Cleared → ${filePath}`
    );
  }
}


// ============================================================================
// GET LAST STEPS
// ============================================================================

/**
 * getRecentSteps(logArray, count = 5)
 *
 * Convenience function for components that need recent history.
 *
 * The full log remains untouched.
 */
function getRecentSteps(
  logArray,
  count = 5
) {

  if (
    !Array.isArray(logArray)
  ) {
    return [];
  }


  const safeCount =
    Math.max(
      0,
      Number(count) || 0
    );


  return logArray.slice(
    -safeCount
  );
}


// ============================================================================
// GET SUCCESSFUL STEPS
// ============================================================================

function getSuccessfulSteps(logArray) {

  if (
    !Array.isArray(logArray)
  ) {
    return [];
  }


  return logArray.filter(
    step =>
      step &&
      step.success !== false
  );
}


// ============================================================================
// GET FAILED STEPS
// ============================================================================

function getFailedSteps(logArray) {

  if (
    !Array.isArray(logArray)
  ) {
    return [];
  }


  return logArray.filter(
    step =>
      step &&
      step.success === false
  );
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  storeStep,
  saveLog,
  loadLog,
  clearLog,
  getRecentSteps,
  getSuccessfulSteps,
  getFailedSteps
};