# jev-permission-gate

A Claude Code mod that puts [TypeSafe's Jev](https://docs.typesafe.ai/) in front of the auto mode classifier. In auto mode, for each tool call Claude Code would otherwise send to the classifier, Jev answers seven yes/no questions in one request and the mod decides:

- **allow** when Jev is at least 85% sure the call serves your request and every risk check is at or below 25%. The built-in classifier doesn't run.
- **deny** when the call is both risky and unrequested: some risk check at or above 80% and "serves your request" at or below 30%. Claude sees the reason.
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

## Evals

`evals/cases.json` (53 labeled calls, used to pick wording and thresholds) and `evals/holdout.json` (24 calls, mostly subtle overreach, held out) run against the live API:

```bash
node evals/run.ts                                  # all wording variants on the tuning set
node evals/run.ts --cases=holdout --variant=shipped  # the shipped wording on the held-out set
```

Each run costs about 600 input tokens per case per variant per rep, a fraction of a cent. Per-call rows land in `evals/results/` (gitignored). Results on 2026-10-02 with `jev-1.13.0`, two reps each:

| Set | Unsafe allows | Wrong denials | Routine requested calls allowed |
| - | - | - | - |
| Tuning (53) | 0 | 0 | 84% |
| Held out (24) | 0 | 0 | 67% |

Every miss was a deferral to the built-in classifier. The tuning set's paired asked/not-asked design follows [jomatsu/pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode) (MIT), and five of its cases are adapted from that project's calibration fixtures.

## Head-to-head with the built-in classifier

`gate.json` (gitignored) sets the gate's mode: `enforce` (the default), `shadow` (Jev only observes; the classifier decides every call), or `measure` (Jev is never asked; the classifier is timed alone). Each call's whole permission wait (call start to return, minus the tool's own run time) goes to `logs/compare.jsonl`, and `node evals/compare.ts --since=<ISO time>` summarizes it.

On 2026-10-02, the same 24 classifier-bound commands, one call per turn in a live session:

| Path | Calls | Median | 90th percentile | Mean |
| - | - | - | - | - |
| Built-in classifier only | 25 | 329ms | 459ms | 346ms |
| Gate enforcing, all calls | 24 | 306ms | 532ms | 291ms |
| …decided by Jev | 11 | 164ms | 245ms | 192ms |
| …deferred to the classifier | 13 | 321ms | 535ms | 376ms |

Jev halves the wait on calls it decides, and deferring costs little at the median because the classifier's work overlaps Jev's request. Overall the gate cut the mean permission wait by 55ms per call (16%). In shadow mode Jev and the classifier agreed on all 11 calls Jev would have decided.

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
