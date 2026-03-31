const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'capstone.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  console.log("🛠️ Initializing database at:", dbPath);
  db.run("PRAGMA foreign_keys = ON");

  // Drop old tables to avoid conflicts
  db.run(`DROP TABLE IF EXISTS Test_Execution`);
  db.run(`DROP TABLE IF EXISTS Test_Step`);
  db.run(`DROP TABLE IF EXISTS Test_Case`);
  db.run(`DROP TABLE IF EXISTS exploration_log`);

  // Define Test_Case with all necessary columns
  db.run(`
    CREATE TABLE Test_Case (
      id INTEGER PRIMARY KEY AUTOINCREMENT, 
      app_id INTEGER,
      objective TEXT,
      expected_result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Define Test_Step linked to Test_Case
  db.run(`
    CREATE TABLE Test_Step (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_case_id INTEGER,
      step_number INTEGER,
      action TEXT,
      selector TEXT,
      value TEXT,
      FOREIGN KEY(test_case_id) REFERENCES Test_Case(id) ON DELETE CASCADE
    )
  `);

  // Define Test_Execution for results
  db.run(`
    CREATE TABLE Test_Execution (
      execution_id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_case_id INTEGER,
      status TEXT CHECK(status IN ('PASS','FAIL')),
      error_message TEXT,
      execution_time REAL,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(test_case_id) REFERENCES Test_Case(id) ON DELETE CASCADE
    )
  `);

  console.log("🧪 Inserting smoke-test data...");
  db.run(`INSERT INTO Test_Case (id, objective, expected_result) VALUES (1, 'Verify navigation', 'Page should load')`);
  db.run(`INSERT INTO Test_Step (test_case_id, step_number, action, selector, value) 
          VALUES (1, 1, 'navigate', '', 'https://demoqa.com')`);
});

db.close((err) => {
  if (err) return console.error(err.message);
  console.log("✅ Database successfully initialized.");
});