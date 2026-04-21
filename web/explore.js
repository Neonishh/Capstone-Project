const { chromium } = require('playwright');
const sqlite3 = require('sqlite3').verbose();
const { execSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const dbPath = path.join(rootDir, 'database', 'capstone.db');
const pythonScript = path.join(__dirname, 'arch-b-vision', 'yolo_ocr.py');

async function runPipeline(url, siteName) {
    const db = new sqlite3.Database(dbPath);
    const startTime = new Date().toISOString();
    console.log(`--- [${startTime}] Starting Extraction ---`);

    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    try {
        await page.goto(url, { waitUntil: 'networkidle' });
        db.run('INSERT INTO runs (url, site_name, start_time) VALUES (?, ?, ?)', [url, siteName, startTime], function(err) {
            if (err) return console.error("DB Error:", err.message);
            const runId = this.lastID;

            // Path A: DOM + Memory 
            (async () => {
                const html = await page.content();
                const memory = JSON.stringify(await page.evaluate(() => window.performance.getEntries()));
                db.run('INSERT INTO dom_results (run_id, html, memory_log) VALUES (?, ?, ?)', [runId, html, memory]);
                console.log('✔ Path A: DOM Data Captured');
            })();

            // Path B: Vision + OCR 
            (async () => {
                const screenshotName = `${siteName}_${Date.now()}.png`;
                const screenshotPath = path.join(__dirname, 'logs', 'screenshots', screenshotName);
                await page.screenshot({ path: screenshotPath });
                try {
                    const ocrData = execSync(`python "${pythonScript}" "${screenshotPath}"`).toString();
                    db.run('INSERT INTO vision_results (run_id, screenshot_path, ocr_data) VALUES (?, ?, ?)', [runId, screenshotPath, ocrData]);
                    console.log('✔ Path B: Vision/YOLO Data Captured');
                } catch (e) { console.log('✖ Path B Failed'); }
            })();
        });
    } catch (e) { console.error('Pipeline Error:', e.message); }
    setTimeout(() => { browser.close(); db.close(); console.log('--- Run Finished ---'); }, 7000);
}

// NEW: Inspect the actual results 
function inspectRun(id) {
    const db = new sqlite3.Database(dbPath);
    db.get(`SELECT r.site_name, d.html, v.ocr_data 
            FROM runs r 
            JOIN dom_results d ON r.id = d.run_id 
            JOIN vision_results v ON r.id = v.run_id 
            WHERE r.id = ?`, [id], (err, row) => {
        if (!row) return console.log("Run ID not found.");
        console.log(`\n--- INSPECTING RUN: ${row.site_name} ---`);
        console.log(`DOM Size: ${row.html.length} characters`);
        console.log(`Vision OCR Preview: ${row.ocr_data.substring(0, 200)}...`);
        db.close();
    });
}

const [,, cmd, arg1, arg2] = process.argv;
if (cmd === 'run') runPipeline(arg1, arg2);
else if (cmd === 'list') {
    const db = new sqlite3.Database(dbPath);
    db.all("SELECT * FROM runs", [], (err, rows) => { console.table(rows); db.close(); });
}
else if (cmd === 'inspect') inspectRun(arg1);
else console.log('Usage: node web/explore.js [run <url> <name> | list | inspect <id>]');
