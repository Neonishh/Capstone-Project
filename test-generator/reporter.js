const fs = require('fs');

const path = require('path');

const filePath = path.join(__dirname, '../mobile/logs/mobile_test_cases.json');

const data = JSON.parse(fs.readFileSync(filePath));

console.log("===== TEST SUMMARY =====");
console.log("Objective:", data.objective);
console.log("Total Steps:", data.steps.length);

data.steps.forEach((step, i) => {
  console.log(`Step ${i + 1}: ${step.action} → ${step.target}`);
});

console.log("Expected Result:", data.expected_result);