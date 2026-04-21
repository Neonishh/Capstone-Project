// memoryLog.js
// Logging utility for Arch B steps

const fs = require('fs').promises;
const path = require('path');

async function logStep(data) {
    const logPath = path.join(__dirname, 'arch_b_memory_log.json');
    await fs.appendFile(logPath, JSON.stringify(data) + '\n');
}

module.exports = { logStep };
