'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseOption, selectNativeOption } = require('../src/dropdown');

const options = [
  { value: '', text: 'Choose', selected: true },
  { value: '03', text: 'March', selected: false },
  { value: '04', text: 'April', disabled: true }
];

test('exploration skips placeholders and disabled choices', () => {
  assert.equal(chooseOption(options).value, '03');
  assert.equal(chooseOption(options, 'March').value, '03');
  assert.throws(() => chooseOption(options, 'April'), /no enabled option/);
});

test('execution rejects invalid requests without selecting an alternative', async () => {
  let selections = 0;
  const locator = { evaluate: async () => options, selectOption: async () => selections++ };
  await assert.rejects(selectNativeOption(locator, 'May'), /no enabled option/);
  assert.equal(selections, 0);
});

test('exploration logs failure before one retry and returns actual value', async () => {
  const events = [];
  const locator = {
    evaluate: async () => options,
    selectOption: async ({ value }) => events.push(value),
    inputValue: async () => '03'
  };
  const result = await selectNativeOption(locator, 'May', {
    recover: true, onFailure: async () => events.push('failed')
  });
  assert.deepEqual(events, ['failed', '03']);
  assert.equal(result, '03');
});

test('recovery stops after a second selection failure', async () => {
  let attempts = 0;
  const locator = {
    evaluate: async () => options,
    selectOption: async () => { attempts++; throw new Error('detached'); }
  };
  await assert.rejects(selectNativeOption(locator, 'March', { recover: true }), /detached/);
  assert.equal(attempts, 2);
});
