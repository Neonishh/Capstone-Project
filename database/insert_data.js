const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const db = new sqlite3.Database('capstone.db');

const filePath = path.join(__dirname, '../mobile/logs/mobile_test_cases.json');
const data = JSON.parse(fs.readFileSync(filePath));

db.serialize(() => {

  db.run(
    "INSERT INTO test_cases (objective) VALUES (?)",
    [data.objective],
    function (err) {
      if (err) {
        console.error("Insert test case error:", err);
        return;
      }

      const testId = this.lastID;

      const stmt = db.prepare(
        "INSERT INTO test_steps (test_id, action, target) VALUES (?, ?, ?)"
      );

      data.steps.forEach(step => {
        stmt.run(testId, step.action, step.target);
      });

      stmt.finalize(err => {
        if (err) console.error("Finalize error:", err);
        
        console.log("✅ Data inserted correctly");
        
        db.close();  // CLOSE ONLY AFTER EVERYTHING IS DONE
      });
    }
  );

});