const { callLLM } = require('./src/llmClient');

(async () => {
  const res = await callLLM('Reply with JSON {"ok":true}');
  console.log(JSON.stringify(res));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
