# jev-permission-gate

A Claude Code mod that puts [TypeSafe's Jev](https://docs.typesafe.ai/) in front of the auto mode classifier. In auto mode, for each tool call Claude Code would otherwise send to the classifier, Jev answers seven yes/no questions in one request and the mod decides:

- **allow** when Jev is at least 85% sure the call serves your request and every risk check is at or below 15%. The built-in classifier doesn't run.
- **deny** when any risk check is at or above 90%, or "serves your request" is at or below 10%. Claude sees the reason.
- **defer** everything else to the built-in classifier, unchanged.

Commands matching a fixed blocklist (sudo, recursive `rm`, `git push`, credential files, infrastructure and database CLIs, and similar) never reach Jev and always go to the built-in classifier. Jev only sees your recent messages, recent messages from other sessions (kept in a separate `peer_requests` field), and the pending call, never tool output.

If the key is missing, TypeSafe errors, or Jev takes longer than 1.5 seconds, the call goes to the built-in classifier.

## Requirements

- Claude Code 2.1.287 or later, with mods enabled for your account
- `TYPESAFE_API_KEY` in your environment, or as a `TYPESAFE_API_KEY=...` line in a `.env` file beside this README (gitignored). Get a key from [console.typesafe.ai](https://console.typesafe.ai/keys).
- Optional: `TYPESAFE_DEFAULT_MODEL` to pin a version such as `jev-1.13.0` instead of `jev-latest`

## Use

```bash
claude --plugin-dir ~/Developer/jev-permission-gate
```

Inside the session, `/jev-gate` shows counts, Jev latency, and the last 15 decisions with their reasons. Every decision, including calls the gate passed through untouched, is also written to `logs/decisions.jsonl` (gitignored, last 1,000 lines).

## Tune

Thresholds, the tool list, and the timeout live in `DEFAULT_CONFIG` in `hooks/policy.ts`. The blocklist is `RISKY_PROGRAMS` (matched against each command segment's program) and `RISKY_PATTERNS` (matched against the whole command) in the same file.

## Test

```bash
node --test tests/*.spec.ts   # policy logic, runs anywhere
claude plugin test            # end-to-end hook tests, needs mods enabled
claude plugin validate .
```

## Layout

| File | Role |
| - | - |
| `hooks/register.ts` | Wiring: `tool.check`, permission-mode tracking, `/jev-gate` |
| `hooks/policy.ts` | Pure logic: blocklist, Jev questions, state, thresholds |
| `hooks/typesafe.ts` | Typed request and response for `POST /v1/systemone` |

## Prior art

Design ideas borrowed from [bouncer](https://github.com/michaeldstenner/bouncer) (unsure verdicts hand off to auto mode) and [io-auto-mode](https://github.com/simon-inkie/inkie-auto-mode) (keep assistant text out of the classifier's input). Both are MIT licensed. No code was copied.
