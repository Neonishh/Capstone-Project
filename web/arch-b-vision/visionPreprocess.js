// visionPreprocess.js
// Stubs for YOLO and OCR integration

const { spawn } = require('child_process');

async function runYOLO(screenshotPath) {
    const result = await runPythonYOLOOCR(screenshotPath);
    return result.yolo || [];
}

async function runOCR(screenshotPath) {
    const result = await runPythonYOLOOCR(screenshotPath);
    return result.ocr || [];
}

function runPythonYOLOOCR(screenshotPath) {
    return new Promise((resolve, reject) => {
        const py = spawn('python', [
            'arch-b-vision/yolo_ocr.py',
            screenshotPath
        ], { cwd: __dirname });
        let data = '';
        py.stdout.on('data', (chunk) => { data += chunk; });
        py.stderr.on('data', (err) => { /* Optionally log errors */ });
        py.on('close', () => {
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                reject(e);
            }
        });
    });
}

module.exports = { runYOLO, runOCR };
