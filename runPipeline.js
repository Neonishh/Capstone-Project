const { execSync } = require('child_process');

try {
  console.log("🚀 Running Mobile Test Generator...");
  execSync('python mobile/src/test_generator.py', { stdio: 'inherit' });

  console.log("📄 Generating Playwright Script...");
  execSync('node test-generator/scriptConverter.js', { stdio: 'inherit' });

  console.log("🛠 Initializing DB...");
  execSync('node database/init_db.js', { stdio: 'inherit' });

  console.log("🗄 Inserting into DB...");
  execSync('node database/insert_data.js', { stdio: 'inherit' });

  console.log("📊 Generating Report...");
  execSync('node test-generator/reporter.js', { stdio: 'inherit' });

  console.log("✅ Pipeline Complete!");
} catch (err) {
  console.error("❌ Pipeline failed:", err);
}