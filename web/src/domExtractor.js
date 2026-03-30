'use strict';

async function getDOMElements(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 200); // slowed from 150 to 200
    });
  });

  await page.waitForTimeout(500);

  const elements = await page.evaluate(() => {
    const nodes = document.querySelectorAll('button, input, a, select, textarea');
    const results = [];

    nodes.forEach((el, index) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;

      let selector = '';
      if (el.id) {
        selector = '#' + el.id;
      } else if (el.getAttribute('name')) {
        selector = `[name="${el.getAttribute('name')}"]`;
      } else if (el.className && typeof el.className === 'string' && el.className.trim()) {
        const classes = el.className.trim().split(/\s+/).join('.');
        selector = el.tagName.toLowerCase() + '.' + classes;
      } else {
        selector = el.tagName.toLowerCase() + ':nth-of-type(' + (index + 1) + ')';
      }

      const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
      const inputType = el.getAttribute('type') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const text = (el.innerText || el.value || el.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 100);

      results.push({
        elementId: index,
        tag: el.tagName,
        text,
        id: el.id || null,
        className: el.className || '',
        selector,
        href,
        inputType,
        placeholder,
        ariaLabel,
        name: el.getAttribute('name') || null,
      });
    });

    return results;
  });

  return elements;
}

async function getPageMeta(page) {
  const url = page.url();
  const title = await page.title();
  return { url, title };
}

module.exports = { getDOMElements, getPageMeta };