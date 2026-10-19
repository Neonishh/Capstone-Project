# WebdriverIO v2.2.0 pilot results

App installed on emulator-5554: com.wdiodemoapp/.MainActivity.

| Run | Passed | Total |
|---|---:|---:|
| Generated vision replay | 1 | 1 |
| Adapted reference smoke | 4 | 4 |

Vision report: `mobile/logs/vision/20261018_181139_457912Z/test_execution/vision_execution_report.json`
Reference report: `mobile/logs/benchmarks/wdio_reference_20261018_181832Z/report.json`

Reference checks: input echo, switch on/off, dropdown selection, and login success dialog. These are Python adaptations, not execution of the original TypeScript suite. Earlier reference adapter failures remain in their timestamped folders.

The five-action AI exploration typed email/password and submitted login, but generated only the initial navigation case: typed values are redacted and not replayable. Therefore 1/1 passed does not mean generated coverage of the four reference behaviors. No DOM benchmark or full A/B comparison was run in this pilot. Next: add explicit synthetic input fixtures and implement equivalent DOM assertions.