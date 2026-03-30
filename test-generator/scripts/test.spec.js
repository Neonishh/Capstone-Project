
const { test, expect } = require('@playwright/test');

test('Test login_page', async ({ page }) => {
  await page.goto('https://example.com');

  await page.getByPlaceholder('Username').fill('test_value');
    
  await page.getByPlaceholder('Password').fill('test_value');
    
  await page.getByText('Login').click();
    
});
