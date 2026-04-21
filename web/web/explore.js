const { chromium } = require('playwright');
const sqlite3 = require('sqlite3').verbose();
const { execSync } = require('child_process');
const path = require('path');

async function runPipeline(url, siteName) {
    const db = new sqlite3.Database('../database/capstone.db');
    const startTime = new Date().toISOString();
    console.log('--- Starting Web Extraction Pipeline ---');

    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    try {
        await page.goto(url, { waitUntil: 'networkidle' });

        db.run('INSERT INTO runs (url, site_name, start_time) VALUES (?, ?, ?)', [url, siteName, startTime], function(err) {
            if (err) return console.error(err.message);
            const runId = this.lastID;

            // Path A: DOM Extraction only 
            (async () => {
                const html = await page.content();
                const memory = JSON.stringify(await page.evaluate(() => window.performance.getEntries()));
                db.run('INSERT INTO dom_results (run_id, html, memory_log) VALUES (?, ?, ?)', [runId, html, memory]);
                console.log('✔ Path A (DOM) Complete');
            })();

            // Path B: Vision + Metadata extraction 
            (async () => {
                const screenshotName = `${siteName}_${Date.now()}.png`;
                const screenshotPath = path.join(__dirname, 'logs', 'screenshots', screenshotName);
                await page.screenshot({ path: screenshotPath });
                
                try {
                    // Call Python YOLO script with the path as an argument
                    const ocrData = execSync(`python arch-b-vision/yolo_ocr.py "${screenshotPath}"`).toString();
                    db.run('INSERT INTO vision_results (run_id, screenshot_path, ocr_data) VALUES (?, ?, ?)', [runId, screenshotPath, ocrData]);
                    console.log('✔ Path B (Vision) Complete');
                } catch (e) {
                    console.log('✖ Path B (Vision) failed: Check if YOLO script is working');
                }
            })();
        });
    } catch (e) {
        console.error('Pipeline Error:', e.message);
    }

    // Give some time for async DB writes before closing
    setTimeout(() => { browser.close(); db.close(); console.log('--- Run Finished: Results saved to DB  ---'); }, 8000);
}

const args = process.argv.slice(2);
if (args.length < 2) console.log('Usage: node explore.js <URL> <SiteName>');
else runPipeline(args[0], args[1]);
