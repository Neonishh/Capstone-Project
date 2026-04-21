// mainPipeline.js
// Vision-based exploration loop for Web Architecture B

const { chromium } = require('playwright');
const path = require('path');
const { runYOLO, runOCR } = require('./visionPreprocess');
const { llmReason } = require('./llmClient');
const { logStep } = require('./memoryLog');

async function mainPipeline(url, maxSteps = 10) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url);

    for (let step = 0; step < maxSteps; step++) {
        // 1. Take screenshot
        const screenshotPath = path.join(__dirname, `step_${step}.png`);
        await page.screenshot({ path: screenshotPath });

        // 2 & 3. YOLO object detection and OCR extraction
        const yoloResults = await runYOLO(screenshotPath);
        const ocrResults = await runOCR(screenshotPath);

        // 4. Build visual DOM
        const visualDOM = buildVisualDOM(yoloResults, ocrResults);

        // 5. LLM chooses action
        const action = await llmReason(visualDOM);
        if (!action || typeof action.x !== 'number' || typeof action.y !== 'number') {
            console.log('No valid action returned by LLM. Stopping.');
            break;
        }

        // 6. Execute action using coordinates
        await page.mouse.click(action.x, action.y);

        // 7. Log step
        await logStep({ step, screenshotPath, action, visualDOM });
    }
    await browser.close();
}

function buildVisualDOM(yoloResults, ocrResults) {
    // Combine YOLO and OCR results into a structured visual DOM
    return { yolo: yoloResults, ocr: ocrResults };
}

if (require.main === module) {
    // Example usage: node mainPipeline.js https://example.com 5
    const url = process.argv[2] || 'https://example.com';
    const maxSteps = parseInt(process.argv[3], 10) || 3;
    mainPipeline(url, maxSteps).then(() => {
        console.log('Pipeline finished.');
    });
}

module.exports = { mainPipeline };
