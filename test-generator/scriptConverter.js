const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../mobile/logs/mobile_test_cases.json');
const data = JSON.parse(fs.readFileSync(filePath));

let script = `
const { test, expect } = require('@playwright/test');

test('${data.objective}', async ({ page }) => {
  await page.goto('https://example.com');
`;

data.steps.forEach(step => {

  if (step.action === 'fill') {
    script += `
  await page.getByPlaceholder('${step.target}').fill('${step.value}');
    `;
  }

  if (step.action === 'click') {
    script += `
  await page.getByText('${step.target}').click();
    `;
  }

});

script += `
});
`;

const outputPath = path.join(__dirname, 'scripts', 'test.spec.js');

fs.writeFileSync(outputPath, script);

console.log("✅ Script generated");