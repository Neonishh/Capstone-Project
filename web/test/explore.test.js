const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldCaptureScreenshot,
  selectRelevantSubFeatures,
  selectTopLevelFeatures,
  selectPageSubFeatures
} = require('../explore');

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

test('selects the DemoQA top-level categories and excludes the Book Store app', () => {
  const elements = [
    { elementId: 1, tag: 'A', text: 'Elements', href: '/elements', selector: 'a[href="/elements"]' },
    { elementId: 2, tag: 'A', text: 'Forms', href: '/forms', selector: 'a[href="/forms"]' },
    { elementId: 3, tag: 'A', text: 'Alerts, Frame & Windows', href: '/alertsWindows', selector: 'a[href="/alertsWindows"]' },
    { elementId: 4, tag: 'A', text: 'Widgets', href: '/widgets', selector: 'a[href="/widgets"]' },
    { elementId: 5, tag: 'A', text: 'Interactions', href: '/interaction', selector: 'a[href="/interaction"]' },
    { elementId: 6, tag: 'A', text: 'Book Store Application', href: '/books', selector: 'a[href="/books"]' }
  ];

  const selected = selectTopLevelFeatures(elements);

  assert.deepEqual(
    selected.map(item => item.name),
    ['Elements', 'Forms', 'Alerts, Frame & Windows', 'Widgets', 'Interactions']
  );
});

test('selects the first two sub-features for a category page in DOM order', () => {
  const elements = [
    { elementId: 1, tag: 'A', text: 'Text Box', href: '/text-box', selector: 'a[href="/text-box"]' },
    { elementId: 2, tag: 'A', text: 'Check Box', href: '/check-box', selector: 'a[href="/check-box"]' },
    { elementId: 3, tag: 'A', text: 'Radio Button', href: '/radio-button', selector: 'a[href="/radio-button"]' },
    { elementId: 4, tag: 'A', text: 'Web Tables', href: '/web-tables', selector: 'a[href="/web-tables"]' }
  ];

  const selected = selectPageSubFeatures(elements, 2);

  assert.deepEqual(
    selected.map(item => item.name),
    ['Text Box', 'Check Box']
  );
});
