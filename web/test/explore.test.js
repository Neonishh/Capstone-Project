const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldCaptureScreenshot, selectRelevantSubFeatures } = require('../explore');

test('captures screenshots for the first step and for interaction actions', () => {
  assert.equal(shouldCaptureScreenshot(false, 0, false), true);
  assert.equal(shouldCaptureScreenshot('click', 1, false), true);
  assert.equal(shouldCaptureScreenshot('fill', 2, false), true);
  assert.equal(shouldCaptureScreenshot('navigate', 3, false), true);
  assert.equal(shouldCaptureScreenshot('done', 4, false), false);
});

test('respects the screenshot-every-step flag', () => {
  assert.equal(shouldCaptureScreenshot('done', 5, true), true);
  assert.equal(shouldCaptureScreenshot('done', 6, false), false);
});

test('keeps a feature exploration to at most two representative sub-features', () => {
  const elements = [
    { elementId: 1, tag: 'INPUT', inputType: 'text', label: 'First Name', selector: '#firstName' },
    { elementId: 2, tag: 'INPUT', inputType: 'text', label: 'Last Name', selector: '#lastName' },
    { elementId: 3, tag: 'INPUT', inputType: 'email', label: 'Email', selector: '#email' },
    { elementId: 4, tag: 'INPUT', inputType: 'checkbox', label: 'Sports', selector: '#sports' },
    { elementId: 5, tag: 'INPUT', inputType: 'checkbox', label: 'Reading', selector: '#reading' },
    { elementId: 6, tag: 'INPUT', inputType: 'radio', name: 'gender', label: 'Male', selector: '#male' },
    { elementId: 7, tag: 'A', text: 'Home', href: '/', selector: 'a[href="/"]' },
    { elementId: 8, tag: 'BUTTON', text: 'Submit', selector: 'button[type="submit"]' }
  ];

  const selected = selectRelevantSubFeatures(elements, 2);

  assert.equal(selected.length <= 2, true);
  assert.equal(selected.some(item => item.kind === 'form'), true);
  assert.equal(selected.some(item => item.kind === 'checkbox' || item.kind === 'radio'), true);
  assert.equal(selected.some(item => item.kind === 'link' || item.kind === 'button'), false);
});
