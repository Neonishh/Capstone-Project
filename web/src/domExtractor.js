/**
 * domExtractor.js
 * Day 1 – Nidhi K
 * Responsibility: Extract all interactive DOM elements from a live browser page
 * using Playwright's page.evaluate(). Returns raw element array for preprocessing.
 */

/**
 * getDOMElements(page)
 * Runs inside the browser context via page.evaluate().
 * Queries all interactive tags: button, input, a, select, textarea.
 * Returns an array of element descriptor objects.
 *
 * @param {import('playwright').Page} page - Playwright Page instance
 * @returns {Promise<Array>} - Array of raw element objects
 */
async function getDOMElements(page) {
  const elements = await page.evaluate(() => {
    const INTERACTIVE_TAGS = ['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA'];

    const nodes = document.querySelectorAll(
      'button, input, a, select, textarea'
    );

    const results = [];

    nodes.forEach((el, index) => {
      // Skip hidden elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;

      // Build the best available selector
      let selector = '';
      if (el.id) {
        selector = '#' + el.id;
      } else if (el.className && typeof el.className === 'string') {
        const firstClass = el.className.trim().split(/\s+/)[0];
        if (firstClass) selector = '.' + firstClass;
      } else {
        selector = el.tagName.toLowerCase();
      }

      // Gather href for anchor tags
      const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';

      // Gather type for input/button
      const inputType = el.getAttribute('type') || '';

      // Gather placeholder for inputs
      const placeholder = el.getAttribute('placeholder') || '';

      // Gather aria-label as fallback text
      const ariaLabel = el.getAttribute('aria-label') || '';

      // Clean visible text
      const text = (el.innerText || el.value || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100); // cap long texts

      results.push({
        elementId: index,           // sequential ID assigned here
        tag: el.tagName,
        text: text,
        id: el.id || null,
        className: el.className || '',
        selector: selector,
        href: href,
        inputType: inputType,
        placeholder: placeholder,
        ariaLabel: ariaLabel,
        name: el.getAttribute('name') || null,
      });
    });

    return results;
  });

  return elements;
}

/**
 * getPageMeta(page)
 * Returns basic page metadata: URL and title.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{url: string, title: string}>}
 */
async function getPageMeta(page) {
  const url = page.url();
  const title = await page.title();
  return { url, title };
}

module.exports = { getDOMElements, getPageMeta };
