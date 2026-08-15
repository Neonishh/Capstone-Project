'use strict';

/**
 * domExtractor.js
 *
 * Responsibility:
 *   Extract useful interactive elements and page metadata from a
 *   Playwright page.
 *
 * Important design principle:
 *
 *   Playwright extracts the raw UI information.
 *   The LLM interprets that information and decides what to do.
 *
 * This file should NOT contain website-specific knowledge.
 */

// Maximum number of elements returned to the LLM.
// The preprocessor can apply another limit if necessary.
const MAX_RAW_ELEMENTS = 150;


/**
 * getDOMElements(page)
 *
 * Extracts visible/interactable elements from the current page.
 *
 * We intentionally extract more than just:
 *   button, input, a, select, textarea
 *
 * because modern websites often implement controls using ARIA roles
 * or contenteditable elements.
 */
async function getDOMElements(page) {

  // --------------------------------------------------------------------------
  // Scroll through the page once.
  //
  // This helps trigger lazy-loaded content before extraction.
  // --------------------------------------------------------------------------

  try {
    await page.evaluate(async () => {
      await new Promise(resolve => {
        const distance = 400;
        let totalHeight = 0;

        const maxScrolls = 50;
        let scrollCount = 0;

        const timer = setInterval(() => {
          window.scrollBy(0, distance);

          totalHeight += distance;
          scrollCount++;

          const pageHeight =
            Math.max(
              document.body.scrollHeight,
              document.documentElement.scrollHeight
            );

          if (
            totalHeight >= pageHeight ||
            scrollCount >= maxScrolls
          ) {
            clearInterval(timer);

            window.scrollTo({
              top: 0,
              behavior: 'instant'
            });

            resolve();
          }
        }, 100);
      });
    });

    await page.waitForTimeout(300);

  } catch (err) {
    console.warn(
      '[domExtractor] Page scrolling failed:',
      err.message
    );
  }


  // --------------------------------------------------------------------------
  // Extract elements inside the browser.
  // --------------------------------------------------------------------------

  const elements = await page.evaluate(
    (maxElements) => {

      // ----------------------------------------------------------------------
      // Native interactive elements
      // ----------------------------------------------------------------------

      const selector = [
        'button',
        'input',
        'a',
        'select',
        'textarea',

        // Common ARIA-based controls
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[role="option"]',
        '[role="menuitem"]',

        // Editable custom controls
        '[contenteditable="true"]'
      ].join(',');


      const nodes =
        Array.from(
          document.querySelectorAll(selector)
        );


      const results = [];

      // Used to avoid returning the exact same DOM node twice
      // when selectors overlap.
      const seenNodes = new Set();


      // ----------------------------------------------------------------------
      // Helper: clean text
      // ----------------------------------------------------------------------

      function cleanText(value, maxLength = 150) {
        if (!value) return '';

        return String(value)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, maxLength);
      }


      // ----------------------------------------------------------------------
      // Helper: determine whether element is visible
      // ----------------------------------------------------------------------

      function isVisible(element) {
        const style =
          window.getComputedStyle(element);

        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        ) {
          return false;
        }

        const rect =
          element.getBoundingClientRect();

        return (
          rect.width > 0 &&
          rect.height > 0
        );
      }


      // ----------------------------------------------------------------------
      // Helper: generate a reasonably stable CSS selector.
      //
      // This is primarily a fallback. The LLM will also receive semantic
      // information such as text, role, aria-label, id, name, etc.
      // ----------------------------------------------------------------------

      function generateSelector(element) {

        // ID is usually the best CSS selector.
        if (element.id) {
          return `#${CSS.escape(element.id)}`;
        }


        // Name attribute is useful for forms.
        const name =
          element.getAttribute('name');

        if (name) {
          return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        }


        // data-testid is commonly intended for automation.
        const testId =
          element.getAttribute('data-testid');

        if (testId) {
          return `[data-testid="${CSS.escape(testId)}"]`;
        }


        // data-test is another common testing attribute.
        const dataTest =
          element.getAttribute('data-test');

        if (dataTest) {
          return `[data-test="${CSS.escape(dataTest)}"]`;
        }


        // aria-label can provide a useful selector.
        const ariaLabel =
          element.getAttribute('aria-label');

        if (ariaLabel) {
          return `[aria-label="${CSS.escape(ariaLabel)}"]`;
        }


        // Fall back to a structural selector.
        const tag =
          element.tagName.toLowerCase();

        let current = element;
        const path = [];

        // Limit depth so selectors don't become enormous.
        for (let depth = 0; current && depth < 4; depth++) {

          let part =
            current.tagName.toLowerCase();

          if (current.id) {
            part += `#${CSS.escape(current.id)}`;
            path.unshift(part);
            break;
          }

          const parent =
            current.parentElement;

          if (!parent) {
            path.unshift(part);
            break;
          }

          const siblings =
            Array.from(parent.children)
              .filter(
                child =>
                  child.tagName === current.tagName
              );

          if (siblings.length > 1) {
            const index =
              siblings.indexOf(current) + 1;

            part += `:nth-of-type(${index})`;
          }

          path.unshift(part);

          current = parent;
        }

        return path.join(' > ') || tag;
      }


      // ----------------------------------------------------------------------
      // Helper: obtain accessible-ish text.
      // ----------------------------------------------------------------------

      function getElementText(element) {

        const ariaLabel =
          cleanText(
            element.getAttribute('aria-label')
          );

        if (ariaLabel) {
          return ariaLabel;
        }

        const visibleText =
          cleanText(
            element.innerText ||
            element.textContent
          );

        if (visibleText) {
          return visibleText;
        }

        const value =
          cleanText(
            element.value
          );

        if (value) {
          return value;
        }

        const placeholder =
          cleanText(
            element.getAttribute('placeholder')
          );

        if (placeholder) {
          return placeholder;
        }

        return '';
      }


      // ----------------------------------------------------------------------
      // Extract each element.
      // ----------------------------------------------------------------------

      nodes.forEach((element, originalIndex) => {

        if (results.length >= maxElements) {
          return;
        }

        if (seenNodes.has(element)) {
          return;
        }

        seenNodes.add(element);


        if (!isVisible(element)) {
          return;
        }


        const tag =
          element.tagName.toUpperCase();


        const role =
          element.getAttribute('role') || '';


        const id =
          element.id || null;


        const className =
          typeof element.className === 'string'
            ? element.className
            : '';


        const name =
          element.getAttribute('name') || null;


        const href =
          tag === 'A'
            ? element.getAttribute('href') || ''
            : '';


        const inputType =
          element.getAttribute('type') || '';


        const placeholder =
          element.getAttribute('placeholder') || '';


        const ariaLabel =
          element.getAttribute('aria-label') || '';


        const ariaExpanded =
          element.getAttribute('aria-expanded');


        const ariaChecked =
          element.getAttribute('aria-checked');


        const ariaSelected =
          element.getAttribute('aria-selected');


        const disabled =
          element.disabled === true ||
          element.getAttribute('aria-disabled') === 'true';


        const required =
          element.required === true ||
          element.getAttribute('aria-required') === 'true';


        const text =
          getElementText(element);


        const selector =
          generateSelector(element);


        // --------------------------------------------------------------------
        // Extract nearby label information for form fields.
        // --------------------------------------------------------------------

        let label = '';

        if (element.labels && element.labels.length > 0) {
          label =
            cleanText(
              Array.from(element.labels)
                .map(labelElement => labelElement.innerText)
                .join(' ')
            );
        }


        // Try to find a label using "for".
        if (!label && id) {
          const associatedLabel =
            document.querySelector(
              `label[for="${CSS.escape(id)}"]`
            );

          if (associatedLabel) {
            label =
              cleanText(
                associatedLabel.innerText
              );
          }
        }


        // --------------------------------------------------------------------
        // Bounding box.
        //
        // Useful later if you want to compare DOM elements with YOLO
        // detections.
        // --------------------------------------------------------------------

        const rect =
          element.getBoundingClientRect();


        results.push({
          elementId: originalIndex,

          tag,

          role,

          text,

          label,

          id,

          className,

          selector,

          href,

          inputType,

          placeholder,

          ariaLabel,

          ariaExpanded,

          ariaChecked,

          ariaSelected,

          name,

          disabled,

          required,

          contentEditable:
            element.getAttribute('contenteditable') === 'true',

          checked:
            typeof element.checked === 'boolean'
              ? element.checked
              : null,

          selected:
            typeof element.selected === 'boolean'
              ? element.selected
              : null,

          value:
            tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT'
              ? cleanText(element.value, 100)
              : '',

          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        });
      });


      return results;

    },
    MAX_RAW_ELEMENTS
  );


  return elements;
}


/**
 * getPageMeta(page)
 *
 * Returns basic metadata about the current page.
 */
async function getPageMeta(page) {

  const url =
    page.url();

  let title = '';

  try {
    title =
      await page.title();
  } catch (_) {
    title = '';
  }

  return {
    url,
    title
  };
}


module.exports = {
  getDOMElements,
  getPageMeta
};