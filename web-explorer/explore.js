const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  // ==============================
  // CONFIG
  // ==============================
  const TARGET_URL = 'https://www.amazon.in/';
  const SCREENSHOT_DIR = 'screenshots';
  const LOG_DIR = 'logs';

  const memoryLog = [];
  let actionCounter = 0;
  const maxActionsPerSession = 50; // Prevent infinite loops

  // Ensure directories exist
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  // ==============================
  // LAUNCH BROWSER
  // ==============================
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log("🚀 Opening website...");
  await page.goto(TARGET_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(2000);

  // ==============================
  // STEP 1: SCREENSHOT (INITIAL UI)
  // ==============================
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/0_initial_homepage.png`,
    fullPage: true
  });

  console.log("📸 Initial screenshot captured");

  // ==============================
  // STEP 2: EXTRACT FULL DOM
  // ==============================
  const dom = await page.content();
  fs.writeFileSync(`${LOG_DIR}/dom.html`, dom);

  console.log("🧬 DOM extracted");

  // ==============================
  // STEP 3: DETECT ALL INTERACTIVE ELEMENTS ON HOMEPAGE
  // ==============================
  const initialElements = await page.evaluate(() => {
    const detected = [];
    let elementId = 0;

    document.querySelectorAll('button, a, input, [onclick], [role="button"]').forEach(el => {
      const isVisible = el.offsetParent !== null; // Check if element is visible
      
      if (isVisible) {
        detected.push({
          elementId: elementId++,
          tag: el.tagName,
          text: (el.innerText || el.textContent || el.value || '').substring(0, 50).trim(),
          id: el.id || null,
          class: el.className || null,
          selector: el.getAttribute('data-test-id') || el.id || el.className || el.tagName
        });
      }
    });

    return detected;
  });

  fs.writeFileSync(
    `${LOG_DIR}/initial_elements.json`,
    JSON.stringify(initialElements, null, 2)
  );

  console.log(`🖱️ ${initialElements.length} interactive elements detected on homepage`);

  // ==============================
  // STEP 4: LOG INITIAL STATE
  // ==============================
  memoryLog.push({
    step: actionCounter,
    from_url: TARGET_URL,
    from_title: await page.title(),
    action: "page_load",
    target: null,
    to_url: page.url(),
    to_title: await page.title(),
    screenshot: `0_initial_homepage.png`,
    timestamp: new Date().toISOString()
  });

  actionCounter++;

  // ==============================
  // STEP 5: SYSTEMATICALLY EXPLORE ALL ELEMENTS
  // ==============================
  console.log("\n🔍 Starting systematic exploration of all interactive elements...\n");

  for (let i = 0; i < initialElements.length && actionCounter < maxActionsPerSession; i++) {
    try {
      const element = initialElements[i];
      const elementText = element.text || element.tag;

      console.log(`\n[${i + 1}/${initialElements.length}] Attempting to interact with: "${elementText}"`);

      // Go back to homepage if not already there
      if (page.url() !== TARGET_URL) {
        console.log("  ↩️  Navigating back to homepage...");
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
      }

      // Find and click the element by re-querying (element references may be stale)
      const elementFound = await page.evaluate((index) => {
        const elements = Array.from(document.querySelectorAll('button, a, input, [onclick], [role="button"]'));
        const visibleElements = elements.filter(el => el.offsetParent !== null);
        
        if (index < visibleElements.length) {
          const el = visibleElements[index];
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }
        return false;
      }, i);

      if (!elementFound) {
        console.log(`  ⚠️  Element no longer found or not visible`);
        continue;
      }

      // Wait a bit for scroll animation
      await page.waitForTimeout(500);

      // Take screenshot BEFORE action
      const screenshotBefore = `${actionCounter}_before_${elementText.replace(/\s+/g, '_').substring(0, 20)}.png`;
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${screenshotBefore}`,
        fullPage: true
      });

      console.log(`  📸 Screenshot before action: ${screenshotBefore}`);

      // Perform click action
      await page.evaluate((index) => {
        const elements = Array.from(document.querySelectorAll('button, a, input, [onclick], [role="button"]'));
        const visibleElements = elements.filter(el => el.offsetParent !== null);
        
        if (index < visibleElements.length) {
          visibleElements[index].click();
        }
      }, i);

      console.log(`  ✅ Clicked: "${elementText}"`);

      // Wait for any navigation or content load
      try {
        await Promise.race([
          page.waitForLoadState('networkidle', { timeout: 5000 }),
          page.waitForTimeout(2000)
        ]);
      } catch (e) {
        // Timeout is acceptable; just continue
      }

      await page.waitForTimeout(1000);

      // Take screenshot AFTER action
      const screenshotAfter = `${actionCounter}_after_${elementText.replace(/\s+/g, '_').substring(0, 20)}.png`;
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${screenshotAfter}`,
        fullPage: true
      });

      console.log(`  📸 Screenshot after action: ${screenshotAfter}`);

      // Log the action
      memoryLog.push({
        step: actionCounter,
        from_url: TARGET_URL,
        from_title: "Homepage",
        action: "click",
        target: elementText || element.tag,
        target_element_details: element,
        to_url: page.url(),
        to_title: await page.title(),
        screenshot_before: screenshotBefore,
        screenshot_after: screenshotAfter,
        timestamp: new Date().toISOString()
      });

      actionCounter++;

    } catch (error) {
      console.log(`  ❌ Error processing element ${i}: ${error.message}`);
    }
  }

  // ==============================
  // STEP 6: SAVE COMPREHENSIVE MEMORY LOG
  // ==============================
  fs.writeFileSync(
    `${LOG_DIR}/memory_log.json`,
    JSON.stringify(memoryLog, null, 2)
  );

  console.log("\n🧾 Memory log saved");

  // ==============================
  // STEP 7: SAVE SUMMARY REPORT
  // ==============================
  const summaryReport = {
    exploration_summary: {
      total_actions_performed: actionCounter,
      target_url: TARGET_URL,
      exploration_date: new Date().toISOString(),
      total_elements_explored: initialElements.length,
      screenshot_count: actionCounter * 2 // Before and after for each action
    },
    initial_elements_count: initialElements.length,
    initial_elements: initialElements,
    action_log_entries: memoryLog.length
  };

  fs.writeFileSync(
    `${LOG_DIR}/summary_report.json`,
    JSON.stringify(summaryReport, null, 2)
  );

  console.log("📊 Summary report saved");

  // ==============================
  // CLEANUP
  // ==============================
  await browser.close();
  console.log("\n✅ Comprehensive exploration completed successfully!");
  console.log(`\n📈 Results:`);
  console.log(`   • Total Actions: ${actionCounter}`);
  console.log(`   • Screenshots: ${actionCounter * 2}`);
  console.log(`   • Logs: ${memoryLog.length} entries`);
  console.log(`   • Output Folder: ${SCREENSHOT_DIR}/ & ${LOG_DIR}/\n`);

})();
