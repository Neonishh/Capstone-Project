'use strict';

// Exact selection for execution; exploration may explicitly request recovery.
async function readOptions(locator) {
  return locator.evaluate(el => Array.from(el.options).map(o => ({
    value: o.value, text: o.text.trim(), selected: o.selected,
    disabled: o.disabled || (o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled)
  })));
}

function chooseOption(options, wanted) {
  const enabled = options.filter(o => !o.disabled);
  if (wanted !== undefined && wanted !== null) {
    const text = String(wanted);
    const match = enabled.find(o => o.value === text) ||
      enabled.find(o => o.text === text) ||
      enabled.find(o => o.text.toLowerCase() === text.toLowerCase());
    if (!match) throw new Error(`select: no enabled option matching "${text}"`);
    return match;
  }
  const usable = enabled.filter(o => o.value !== '');
  const match = usable.find(o => !o.selected) || usable[0];
  if (!match) throw new Error('select: no usable option found');
  return match;
}

async function selectNativeOption(locator, wanted, { recover = false, onFailure = async () => {} } = {}) {
  let option;
  try {
    option = chooseOption(await readOptions(locator), wanted);
    await locator.selectOption({ value: option.value }, { timeout: 5000 });
  } catch (error) {
    if (!recover) throw error;
    await onFailure(error);
    // One retry only, based on a fresh snapshot of actual options.
    option = chooseOption(await readOptions(locator));
    await locator.selectOption({ value: option.value }, { timeout: 5000 });
  }
  const actual = await locator.inputValue();
  if (actual !== option.value) throw new Error('select: selected value differs from requested option');
  return actual;
}

module.exports = { chooseOption, readOptions, selectNativeOption };
