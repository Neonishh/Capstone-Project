const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, '../database/capstone.db'));

db.serialize(() => {
    db.run("PRAGMA foreign_keys = ON");

    // Your Table: The "Goal" (e.g., Check Wikipedia)
    db.run(`CREATE TABLE IF NOT EXISTS Test_Case (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT UNIQUE,
        app_id INTEGER
    )`);

    // Your Table: The manual steps inside the test
    db.run(`CREATE TABLE IF NOT EXISTS Test_Step (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_case_id INTEGER,
        step_number INTEGER,
        action TEXT,
        selector TEXT,
        value TEXT,
        FOREIGN KEY(test_case_id) REFERENCES Test_Case(id) ON DELETE CASCADE
    )`);

    // Our Table: Path A/B Extraction Results linked to the Goal
    db.run(`CREATE TABLE IF NOT EXISTS Extraction_Results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_case_id INTEGER,
        dom_content TEXT,
        vision_ocr TEXT,
        screenshot_path TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(test_case_id) REFERENCES Test_Case(id)
    )`);

    console.log('? Unified Database Schema Initialized.');
});
db.close();
