# Independent CSV and security audit

Scope: `src/core.ts`, `src/worker.ts`, `src/main.tsx`, `index.html`, recipe/workspace import boundaries, existing core/E2E tests, and the separate adversarial test suite. The auditor changed only `tests/security-audit.test.ts` and this report. Implementation fixes were made by the project owner and independently retested.

## Findings and verified fixes

All findings below were reproducible with synthetic data. They concern local availability or artifact integrity; no remote execution, data exfiltration or credential access was found in the reviewed code.

| Severity | Finding and evidence before the fix | Remediation and verification |
| --- | --- | --- |
| Medium | Allowed-value messages multiplied an entire allowed list into every rejected row. An 8,006-byte CSV with 1,000 invalid records and a 13,273-byte recipe produced 12,999,000 characters of diagnostic messages. The accepted 10,000-record / 256 KB recipe limits permitted much larger amplification. | Allowed lookup is precomputed as a `Set`; each diagnostic includes a bounded preview of eight values, truncated to 40 characters each, plus the count. The regression requires every generated message to be under 500 characters. Passed. |
| Medium | Creation and import used different aggregate recipe limits. Twenty-six fill rules with 10,000-character replacement strings validated in the application, but their own 261,971-byte JSON could not be imported. Formatting was another edge: compact JSON of 248,175 bytes became a 257,280-byte formatted export. | Recipe validation now enforces the aggregate limit and the UI rejects unsupported changes before committing them. The UI uses the validated compact `exportRecipe` artifact, which round-trips under the same import budget. Both regressions passed. |
| Medium | Safe formula protection could create duplicate headers. The distinct headers `=sku` and `'=sku` both exported as `'=sku`, producing CSV rejected on re-import. | Safe export detects the collision and refuses that artifact with an explicit explanation. Exact export preserves both headers. Passed. |
| Medium | A generated backup could exceed its own restore limit. A valid source of approximately 1 MB plus 1,000 manual edits of 8,000 characters fit the processed-value limit but generated a backup above 8 MiB. | Backup generation checks the same 8 MiB boundary as restore and refuses the artifact before downloading it. Export errors are caught in the UI; data stays in the current tab. Passed. |
| Medium | CSV parsing accepted column names that recipes/backups could not represent. A 10,001-character name passed CSV import, while the recipe and restore schema rejected it. An aggregate of fifty 7,000-character headers also exceeded the recipe budget. | CSV parsing, recipe validation and backup restore now use a 256-character name limit. This also bounds aggregate header size within the recipe budget. Both adversarial variants are refused at import. Passed. |

## Adversarial evidence

`tests/security-audit.test.ts` covers these boundaries independently of the normal acceptance suite:

- Prototype-like column names (`__proto__`, `constructor`, `toString`) remain usable data. Manual edits and backup restore preserve them without changing object prototypes; restore rebuilds edit maps with a null prototype.
- Unknown and prototype-related keys are rejected at every recipe schema layer. Invalid backup record IDs, unknown edit columns, non-string edit values and exclusions for nonexistent records are rejected.
- Formula guards protect header/data cells, excluded reasons, tabs, CR/LF and leading Unicode whitespace. Raw rejected values remain preserved in the separate JSON field.
- Exact-mode CSV round-trips quoted separators, embedded quotes, CRLF/LF, lone carriage returns, multiline values, Cyrillic/Kazakh strings, leading-zero IDs and huge numeric identifiers across all four supported delimiters.
- Signed decimal comparisons preserve text representation and exact precision at the 256-character numeric boundary.
- Oversized transformations fail while the immutable input dataset remains unchanged.
- Regressions cover bounded diagnostics, compact/formatted recipe budgets, safe-header collisions, backup generation/restore consistency and column-name consistency.

Run the independent suite with Node.js 24+:

```sh
node --experimental-strip-types --test tests/security-audit.test.ts
```

Final independent suite result: **13 passed, 0 failed**, Node.js `v24.15.0`, **637.7429 ms** on this Windows execution environment. This includes all identified findings and the actual recipe export at its formatting boundary.

The combined normal core suite and independent audit suite also passed: **29 passed, 0 failed**, **704.7585 ms** total. Its 10,000-record parse + trim + unique + integer/range scenario measured **146 ms** in Node.js; this is a runtime measurement, not a browser/device performance claim.

## Reviewed controls and practical limits

React renders imported content as text; no `innerHTML`, `dangerouslySetInnerHTML`, `eval` or user-supplied regular expression execution was found in the reviewed paths. Recipe actions, types and keys use an allowlist. Papa Parse handles CSV parsing and serialization with automatic numeric/date interpretation disabled. The worker performs local computation and does not send datasets over a network. Persistence is opt-in and failures preserve the current in-memory work.

Formula protection intentionally changes risky strings by adding an apostrophe. Exact mode therefore requires an explicit user choice for trusted import destinations. Basic email validation checks syntax only. Maximum supported file/row/cell limits are admission limits, not a universal latency or memory guarantee for every dense validation combination.

This code review and synthetic test run do not prove the absence of all vulnerabilities. The dependency audit repeated by this auditor did **not** complete: the npm registry security endpoint was unavailable from the restricted execution environment. The owner's separately completed dependency audit should be reported separately from this result. No grants, tokens, security settings, other repositories or credentials were changed by this audit.
