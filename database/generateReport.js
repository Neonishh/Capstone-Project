const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to the DB
const dbPath = path.join(__dirname, 'capstone.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // 1. High-Level Summary (Pass/Fail Counts)
  console.log("\n📊 --- TEST EXECUTION SUMMARY ---");
  db.all(`SELECT status, COUNT(*) as count FROM Test_Execution GROUP BY status`, (err, rows) => {
    if (err) return console.error(err.message);
    console.table(rows);
  });

  // 2. Detailed Report
  console.log("\n📝 --- DETAILED TEST REPORT ---");
  const detailedQuery = `
    SELECT 
      te.execution_id as ID,
      tc.objective as Objective,
      te.status as Status,
      te.execution_time as Time_Sec,
      te.error_message as Error,
      te.executed_at as Executed_At
    FROM Test_Execution te
    JOIN Test_Case tc ON te.test_case_id = tc.id
    ORDER BY te.executed_at DESC
  `;
  
  db.all(detailedQuery, (err, rows) => {
    if (err) return console.error(err.message);
    console.table(rows);
  });
});

db.close();