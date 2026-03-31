const { chromium } = require('playwright'); 
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// This tells the web script to look inside the database folder for the DB!
const dbPath = path.join(__dirname, '../database/capstone.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Database connection error:", err.message);
    } else {
        console.log("✅ Connected to the database at:", dbPath);
    }
});

/**
 * Executes a single test case using Playwright
 */
async function runTestCase(testCase) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let status = 'PASS';
  let errorMessage = '';
  const start = Date.now();

  try {
    for (const step of testCase.steps) {
      if (step.action === 'navigate') {
        await page.goto(step.value);
      } else if (step.action === 'click') {
        await page.click(step.selector);
      } else if (step.action === 'fill') {
        await page.fill(step.selector, step.value);
      }
    }
  } catch (err) {
    status = 'FAIL';
    errorMessage = err.message;
  }

  const end = Date.now();
  const execTime = (end - start) / 1000;

  await browser.close();
  return { status, errorMessage, execTime };
}

/**
 * Database Operation: Fetch all test cases
 */
function getTestCases() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM Test_Case`, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Database Operation: Fetch steps for a specific case
 */
function getSteps(testCaseId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM Test_Step WHERE test_case_id = ? ORDER BY step_number`,
      [testCaseId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * Database Operation: Record execution results
 */
function insertExecution(testCaseId, result) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO Test_Execution (test_case_id, status, error_message, execution_time)
       VALUES (?, ?, ?, ?)`,
      [testCaseId, result.status, result.errorMessage, result.execTime],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/**
 * Orchestrator: Main execution loop
 */
async function main() {
  try {
    const testCases = await getTestCases();
    console.log(`🚀 Found ${testCases.length} test cases. Starting execution...`);

    for (const tc of testCases) {
      const stepsRaw = await getSteps(tc.id);

      // Map DB rows to step objects for runTestCase
      const steps = stepsRaw.map(s => ({
        action: s.action,
        selector: s.selector,
        value: s.value
      }));

      console.log(`Running TestCase ${tc.id}...`);
      const result = await runTestCase({ steps });

      await insertExecution(tc.id, result);
      console.log(`Result for ${tc.id}: ${result.status}`);
    }

    console.log("✅ ALL TESTS EXECUTED");
  } catch (error) {
    console.error("❌ Execution Error:", error);
  } finally {
    // Ensure the database connection is closed after all tests run
    db.close();
  }
}

// Start the process
main();