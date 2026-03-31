const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'capstone.db');
const db = new sqlite3.Database(dbPath);

const rawData = fs.readFileSync(path.join(__dirname, 'test_cases.json'));
const testCases = JSON.parse(rawData);

// Helper function to turn callback-based db.run into modern Promises
const runQuery = (query, params = []) => {
  return new Promise((resolve, reject) => {
    // We use function(err) here so we have access to `this.lastID`
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this.lastID); 
    });
  });
};

async function seedDatabase() {
  console.log("Loading real test cases into the database...");

  try {
    // 1. Wipe out old data sequentially (waiting for each to finish)
    await runQuery(`DELETE FROM Test_Step`);
    await runQuery(`DELETE FROM Test_Case`);
    await runQuery(`DELETE FROM Test_Execution`);

    // 2. Loop through JSON and insert sequentially
    for (const tc of testCases) {
      // Insert the parent test case and WAIT to get the generated ID
      const testCaseId = await runQuery(
        `INSERT INTO Test_Case (app_id, objective) VALUES (?, ?)`,
        [tc.app_id, tc.objective]
      );
      
      // Insert all child steps for this test case
      for (const step of tc.steps) {
        await runQuery(
          `INSERT INTO Test_Step (test_case_id, step_number, action, selector, value) VALUES (?, ?, ?, ?, ?)`,
          [testCaseId, step.step_number, step.action, step.selector, step.value]
        );
      }
    }

    console.log("✅ Real test cases successfully injected! Your pipeline is fully legit.");
  } catch (error) {
    console.error("❌ Error seeding database:", error.message);
  } finally {
    // Safely close the database only after ALL operations are completely finished
    db.close();
  }
}

// Execute the async function
seedDatabase();