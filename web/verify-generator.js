const { generateTestCases } = require('./src/testGenerator');

const sampleLog = [
  {
    step: 0,
    action: 'navigate',
    target: 'Home',
    from_url: 'https://demoqa.com',
    to_url: 'https://demoqa.com/elements',
    target_element_details: {
      selector: 'a[href="/elements"]',
      text: 'Elements'
    }
  },
  {
    step: 1,
    action: 'click',
    target: 'Button',
    from_url: 'https://demoqa.com/elements',
    to_url: 'https://demoqa.com/buttons',
    target_element_details: {
      selector: '#button1',
      text: 'Click Me'
    }
  }
];

(async () => {
  const tests = await generateTestCases(sampleLog);
  console.log('count=' + tests.length);
  console.log(JSON.stringify(tests, null, 2));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
