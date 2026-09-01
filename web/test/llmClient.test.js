const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFallbackAction } = require('../src/llmClient');

test('buildFallbackAction prefers navigation for links in Elements flow', () => {
  const action = buildFallbackAction([
    { elementId: 0, tag: 'A', selector: 'a.nav-link', href: 'https://demoqa.com/text-box', text: 'Text Box' }
  ], 'Elements', []);

  assert.equal(action.action, 'navigate');
  assert.equal(action.selector, 'a.nav-link');
  assert.equal(action.url, 'https://demoqa.com/text-box');
});

test('buildFallbackAction prefers filling for inputs in Forms flow', () => {
  const action = buildFallbackAction([
    { elementId: 0, tag: 'INPUT', selector: '#firstName', inputType: 'text', placeholder: 'First Name', text: '' }
  ], 'Forms', []);

  assert.equal(action.action, 'fill');
  assert.equal(action.selector, '#firstName');
  assert.equal(action.value, 'testuser');
});

test('buildFallbackAction returns done when no useful element remains', () => {
  const action = buildFallbackAction([], 'Elements', []);

  assert.equal(action.action, 'done');
});
