const fs = require('fs');

const data = JSON.parse(
  fs.readFileSync('../mobile/logs/mobile_test_cases.json')
);
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

fs.writeFileSync('scripts/test.spec.js', script);

console.log("✅ Script generated");