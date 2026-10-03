# jev-permission-gate

A [Claude Code](https://code.claude.com) mod that puts [TypeSafe's Jev](https://docs.typesafe.ai/) in front of the auto mode classifier. In auto mode, for each tool call Claude Code would otherwise send to its built-in classifier, Jev answers seven yes/no questions in one request and the mod decides:

- **allow** when Jev is at least 85% sure the call serves your request and every risk check is at or below 25%. The built-in classifier doesn't run.
- **deny** when the call is both risky and unrequested: some risk check at or above 80% and "serves your request" at or below 30%. Claude sees the reason.
- **defer** everything else to the built-in classifier, unchanged.

## Results

Measured head to head against Claude Code's built-in classifier in a live session, on identical tool calls (details below):

- **2× faster where Jev decides.** The permission wait drops from a median of 329ms to 164ms.
- **Matching judgment.** Jev's verdicts agreed with the built-in classifier's on every call it would have decided.
- **Safe in testing.** Across 77 labeled cases, including 24 held out and written to probe subtle overreach, it made zero unsafe allows and zero wrong denials. Anything it isn't sure about goes to the built-in classifier.
- **Cheap to defer.** The classifier's work overlaps Jev's request, so calls Jev hands off cost almost nothing extra at the median.

Today Jev decides about half of the calls in a typical workload, which cut the average permission wait by 16% overall. Every point of decision rate raises that: at the 84% Jev reached on the eval set, the projected saving is about 40%. Raising that rate is the main lever for future work.

## How it works

Commands matching a fixed blocklist (`sudo`, recursive `rm`, `git push`, credential files, infrastructure and database CLIs, and similar) never reach Jev and always go to the built-in classifier. Program names are matched against the program each command segment runs, so a path like `/tmp/jev-eval` doesn't read as `eval`.

Jev sees only your recent messages, recent messages from other Claude Code sessions (kept in a separate `peer_requests` field), the pending call, and the project directory. It never sees tool output, so text Claude has read can't argue for its own approval.

If the key is missing, TypeSafe errors, or Jev takes longer than 1.5 seconds, the call goes to the built-in classifier.

## Privacy

Every call the gate judges sends your last three messages (up to 1,500 characters each), the pending command or URL, and your project path to TypeSafe's API. Read [TypeSafe's data handling](https://docs.typesafe.ai/models.md#data-handling) before using it with anything sensitive.

## Requirements

- Claude Code 2.1.287 or later, with mods enabled for your account
- A TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai/keys)

Jev bills input tokens only. Each check is about 550 tokens, a small fraction of a cent.

## Install

From Madison Rickert's public plugin marketplace:

```bash
claude plugin marketplace add madisonrickert/claude-skills
claude plugin install jev-permission-gate@claude-skills
```

Or from inside a session: `/plugin install jev-permission-gate --marketplace madisonrickert/claude-skills`.

Claude Code asks for the plugin's settings when you enable it:

| Setting | Default | What it does |
| - | - | - |
| TypeSafe API key | none | Stored in secure storage. Without it the gate stays out of the way and every call goes to the built-in classifier. |
| Gate mode | `enforce` | `enforce` acts on Jev's verdicts. `shadow` only logs them while the built-in classifier decides. `measure` skips Jev and times the classifier. |
| Jev model | `jev-latest` | Pin a version such as `jev-1.13.0` to keep thresholds stable across releases. |

Change the gate mode and model later in `/config`. Instead of the key setting, you can export `TYPESAFE_API_KEY`.

## Use

The gate only acts in auto mode. Inside a session, `/jev-gate` shows counts, Jev latency, and the last 15 decisions with their reasons.

Logs live in `~/.claude/jev-permission-gate/logs/`, which survives plugin updates:

- `decisions.jsonl`: every decision, including calls the gate passed through untouched
- `compare.jsonl`: each call the built-in classifier decided, with its timing

Each keeps its last 1,000 lines.

## Develop

```bash
git clone https://github.com/madisonrickert/jev-permission-gate.git
claude --plugin-dir ./jev-permission-gate
```

A checkout loaded this way can read the key from a `TYPESAFE_API_KEY=...` line in a `.env` file at the repo root (gitignored). Claude Code hot-reloads the mod when its files change.

## Tune

Thresholds, the tool list, and the timeout live in `DEFAULT_CONFIG` in `hooks/policy.ts`. The blocklist is `RISKY_PROGRAMS` (matched against each command segment's program) and `RISKY_PATTERNS` (matched against the whole command) in the same file.

## Evals

`evals/cases.json` (53 labeled calls, used to pick wording and thresholds) and `evals/holdout.json` (24 calls, mostly subtle overreach, held out) run against the live API:

```bash
node evals/run.ts                                    # all wording variants on the tuning set
node evals/run.ts --cases=holdout --variant=shipped  # the shipped wording on the held-out set
```

Each run costs about 600 input tokens per case per variant per rep. Per-call rows land in `evals/results/` (gitignored). Results on 2026-10-02 with `jev-1.13.0`, two reps each:

| Set | Unsafe allows | Wrong denials | Routine requested calls allowed |
| - | - | - | - |
| Tuning (53) | 0 | 0 | 84% |
| Held out (24) | 0 | 0 | 67% |

Every miss was a deferral to the built-in classifier. One person wrote the labels for both sets, so they test what that person thought to test.

## Head to head with the built-in classifier

Set the gate mode to `shadow` to compare Jev with the built-in classifier on the same calls, or `measure` to time the classifier alone. To switch modes without reloading, write `{ "mode": "shadow" }` to `~/.claude/jev-permission-gate/gate.json`, which overrides the setting and is re-read every few seconds.

Each call's whole permission wait (call start to return, minus the tool's own run time) goes to `compare.jsonl`, and `node evals/compare.ts --since=<ISO time>` summarizes it.

On 2026-10-02, the same 24 classifier-bound commands, one call per turn in a live session:

| Path | Calls | Median | 90th percentile | Mean |
| - | - | - | - | - |
| Built-in classifier only | 25 | 329ms | 459ms | 346ms |
| Gate enforcing, all calls | 24 | 306ms | 532ms | 291ms |
| …decided by Jev | 11 | 164ms | 245ms | 192ms |
| …deferred to the classifier | 13 | 321ms | 535ms | 376ms |

Deferring costs little at the median because the classifier's work appears to overlap Jev's request. The overall gain scales with how many calls Jev decides: at the 84% it reached on the tuning set, the projected saving is roughly 40%. This was one session and one workload of mostly routine commands.

TypeSafe's API also appears to handle one request per account at a time, so parallel tool calls queue their checks at about 100ms each.

## Test

```bash
node --test tests/*.spec.ts   # policy logic, runs anywhere
claude plugin test            # end-to-end hook tests, needs mods enabled
claude plugin validate .
```

## Layout

| File | Role |
| - | - |
| `hooks/register.ts` | Wiring: `tool.check`, permission-mode tracking, timing, `/jev-gate` |
| `hooks/policy.ts` | Pure logic: blocklist, Jev questions, state, thresholds |
| `hooks/typesafe.ts` | Typed request and response for `POST /v1/systemone` |
| `types/index.d.ts` | Session state that survives a hot reload |
| `evals/` | Labeled cases, the eval runner, and the head-to-head summary |

## Prior art

- [bouncer](https://github.com/michaeldstenner/bouncer): unsure verdicts hand off to auto mode.
- [io-auto-mode](https://github.com/simon-inkie/inkie-auto-mode): keep assistant text out of the classifier's input.
- [pi-warden](https://github.com/DevMortimer/pi-warden): the most thoroughly tested Jev gate, for the pi coding agent.
- [pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode): the paired asked/not-asked eval design. Six eval cases are adapted from five of its calibration fixtures; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

All are MIT licensed. Apart from those six adapted cases, no code or data was copied.

## License

[MIT](LICENSE)
