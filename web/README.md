# web

This folder contains the web-side exploration tool that uses Playwright and a Groq LLM to explore web UIs and generate test cases.

Quick start

1. Install dependencies:

```bash
cd web
npm install
```

2. Create `.env` in `web/` with your Groq API key:

```
GROQ_API_KEY=your_api_key_here
# Optional: enable stub LLM for offline testing
STUB_LLM=true
```

3. Run the explorer (pass a URL or defaults to https://demoqa.com):

```bash
npm start -- https://demoqa.com
# or
npm run explore -- https://demoqa.com
```

Notes

- When `STUB_LLM=true` the explorer will not call the Groq API and will instead return a noop `done` action.
- Screenshots and logs are written to the `logs/` directory.
