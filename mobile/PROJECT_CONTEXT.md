# Mobile Project Context

## Current Status

The mobile pipeline is largely wired end to end:

- `explore_mobile.py` launches Appium, captures the view hierarchy, preprocesses visible elements, asks the LLM what to do next, executes the action, logs each step, and then generates test cases from the final memory log.
- `src/view_hierarchy_parser.py` extracts visible Android UI nodes and keeps interactive elements.
- `src/mobile_preprocess.py` filters, deduplicates, ranks, and truncates elements before building the exploration/test-case prompts.
- `src/memory_log.py` stores mobile exploration steps in the same JSON shape used by the web side.
- `src/llm_client.py` supports Groq or OpenAI backends and also supports a stub mode.
- `src/test_generator.py` is intended to convert the completed exploration log into structured test cases.

## What Has Been Implemented

- Appium connection setup with configurable host/port.
- Screenshot capture before and after each action.
- Screen metadata capture using package/activity as the mobile equivalent of URL/title.
- Basic loop detection based on repeated `to_url` values.
- JSON logging of exploration steps to `logs/mobile_memory_log.json`.
- Test-case prompt generation from the recorded exploration history.

## What Is Still Left

- Wire the LLM flow for real app exploration with a valid API key and chosen provider.
- Confirm the test-case generation path returns usable structured test cases for non-stub runs.
- Replace the current placeholder-driven execution path with a stable, fully validated LLM loop.
- Re-run the pipeline against a real target app and verify the logs and screenshots are meaningful.
- Populate or generate `logs/mobile_test_cases.json` during a successful run.

## Stubbed / Placeholder Behavior

- `STUB_LLM=true` in `src/llm_client.py` returns a dummy `done` action instead of calling an API.
- In stub mode, `parse_action()` also returns a fixed `done` action.
- `src/test_generator.py` treats a stub `done` response as "no test cases generated" and exits without writing meaningful test cases.
- The current recorded run in `logs/mobile_memory_log.json` shows repeated failures because `GROQ_API_KEY` was not set.
- `explore_mobile.py` currently defaults to `com.android.settings/.Settings`, so a different app must be supplied with command-line flags when needed.

## Known Gaps / Risks

- `call_llm()` always routes responses through the action parser, which is fine for exploration actions but is not a perfect fit for array-shaped test-case output.
- If the environment is not configured with `GROQ_API_KEY` or `OPENAI_API_KEY`, the exploration loop fails before it can make progress.
- The current log data shows the app remained on the launcher while the LLM call failed, so the run has not yet produced a meaningful exploration trace.

## Useful Output Paths

- Exploration log: `logs/mobile_memory_log.json`
- Screenshots: `logs/screenshots/`
- Planned test cases output: `logs/mobile_test_cases.json`
