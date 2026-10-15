'use strict';

/**
 * fixtures.js
 *
 * DemoQA (like many demo/practice sites) loads third-party ad and tracking
 * scripts that inject floating iframes over the page. A Playwright click
 * or force-check sent to the coordinates of an element underneath one of
 * these iframes can land on the ad instead — this is the most likely
 * explanation for flakes like "checkbox click didn't toggle" or "ended up
 * on demoqa.com/sample" instead of the intended page.
 *
 * This wraps the base `test` so every generated spec automatically blocks
 * known ad/tracker domains, without each generated file needing its own
 * beforeEach. scriptGenerator.js imports `test` from here instead of
 * directly from '@playwright/test'.
 */

const base = require('@playwright/test');

const BLOCKED_DOMAINS = [
  'googlesyndication.com',
  'doubleclick.net',
  'google-analytics.com',
  'googletagmanager.com',
  'googleadservices.com',
  'adsystem.com',
  'amazon-adsystem.com',
  'ezojs.com',
  'ezoic.net',
  'pubmatic.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com'
];

const test = base.test.extend({

  page: async ({ page }, use) => {

    await page.route('**/*', route => {

      const url = route.request().url();

      if (BLOCKED_DOMAINS.some(domain => url.includes(domain))) {
        return route.abort();
      }

      return route.continue();
    });

    await use(page);
  }
});

module.exports = {
  test,
  expect: base.expect
};
