'use strict';

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
 * Schema (per entry):
 * {
 *   step: number,
 *   flow_name: string,        // which flow/feature this step belongs to -
 *                              // needed to group entries per feature
 *   from_url: string,
 *   from_title: string,
 *   action: 'click' | 'fill' | 'navigate',
 *   target: string,
 *   target_element_details: {
 *     elementId: number,
 *     tag: string,
 *     text: string,
 *     id: string | null,
 *     class: string,
 *     selector: string,
 *     inputType: string,      // needed for evidence-based negative tests
 *     required: boolean,      // (e.g. "this field is required" is the
 *     placeholder: string     // only legitimate basis for a negative
 *                              // test case - without it, testGenerator
 *                              // has no evidence and would either never
 *                              // produce one or have to invent it)
 *   },
 *   value: string,            // what was actually typed, for 'fill'
 *   to_url: string,
 *   to_title: string,
 *   success: boolean,         // needed as evidence for negative tests
 *   error: string,
 *   screenshot_before: string,
 *   screenshot_after: string,
 *   timestamp: string
 * }
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


    // Browser state before the action.
    from_url:
      typeof stepData.from_url === 'string'
        ? stepData.from_url
        : '',

    from_title:
      typeof stepData.from_title === 'string'
        ? stepData.from_title
        : '',


    // Action performed.
    action,


    // Human-readable target.
    target:
      typeof stepData.target === 'string'
        ? stepData.target
        : '',


    // Trimmed DOM information for the acted-on element.
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


    // Whether Playwright successfully executed the action. This is the
    // primary evidence source for negative test generation.
    success:
      stepData.success !== false,


    // Execution error, if any.
    error:
      typeof stepData.error === 'string'
        ? stepData.error
        : '',


    // Screenshots (relative paths).
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
 * Keeps only the DOM information needed downstream:
 *   elementId, tag, text, id, class, selector
 * plus inputType/required/placeholder (see schema note above).
 *
 * Everything else that used to be stored here (role, label, href,
 * ariaLabel/ariaExpanded/ariaChecked/ariaSelected, name, disabled,
 * contentEditable, checked, selected, inputValue, boundingBox) is
 * dropped: none of it is read by contextBuilder.js or testGenerator.js,
 * so keeping it only inflated the memory log and, downstream, the
 * test-generation prompt.
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

    text:
      typeof element.text === 'string'
        ? element.text
        : '',

    id:
      typeof element.id === 'string'
        ? element.id
        : null,

    class:
      typeof element.class === 'string'
        ? element.class
        : (typeof element.className === 'string' ? element.className : ''),

    selector:
      typeof element.selector === 'string'
        ? element.selector
        : '',

    inputType:
      typeof element.inputType === 'string'
        ? element.inputType
        : '',

    required:
      element.required === true,

    placeholder:
      typeof element.placeholder === 'string'
        ? element.placeholder
        : ''
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
    `[memoryLog] Saved ${logArray.length} step(s) → ${path.basename(filePath)}`
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