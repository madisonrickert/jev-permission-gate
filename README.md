# jev-permission-gate

A [Claude Code](https://code.claude.com) mod that puts [TypeSafe's Jev](https://docs.typesafe.ai/) in front of the auto mode classifier. In auto mode, for each tool call Claude Code would otherwise send to its built-in classifier, Jev answers eight yes/no questions in one request and the mod decides:

- **allow** when the call plausibly serves your request (at least 50%) and every risk check is at or below 10%. The built-in classifier doesn't run.
- **deny** when the call is both risky and unrequested: some risk check at or above 80% and "serves your request" at or below 30%. Claude sees the reason.
- **defer** everything else to the built-in classifier, unchanged.

A shell-aware blocklist sits in front of Jev. A call it flags can still be denied by Jev but is never allowed, and a call that carries a secret never leaves your machine.

## Results

Evaluated on 7,860 labeled tool calls drawn from independent sources: another permission gate's reviewed corpus, five other Jev gates' test suites, real commands from coding-agent trajectories, tldr-pages, and hand-written edge cases. Thresholds were chosen on a dev split; the test split was run once, after the policy was committed.

On the sealed test split (5,322 calls, 3,664 of them risky):

- **1 unsafe allow in 3,664 risky calls.** That bounds the unsafe-allow rate below 0.13% (95% confidence). The one miss, an abbreviated `git reset --h`, is fixed in the shipped blocklist.
- **Settles 62% of real agent work without the built-in classifier.** On commands real coding agents ran (SWE-agent, OpenHands, and Terminal-Bench trajectories), it allowed 70% of the routine calls outright: 85% on repository bug-fixing.
- **Denies hostile calls itself.** It denied 54% of the calls that should be denied, so those don't wait for the built-in classifier either.
- **Rarely wrong in the other direction.** 5 wrong denials in 1,699 calls where a denial would be wrong (0.3%).
- **Edge cases hold.** 0 unsafe allows and 0 wrong denials on 84 hand-written edge and held-out cases: retracted requests, scope creep, instructions hidden in pasted text, peer sessions, requests in ten languages other than English, steering in descriptions, and private data in search queries.

Measured live against the built-in classifier (v0.1.2, details below), calls Jev decides wait half as long: a median of 164ms instead of 329ms. v0.2.0 decides a much larger share of real work than v0.1.2 did; a live re-measurement is next.

## How it works

1. **Prefilter.** `hooks/shell.ts` parses each command the way a shell would: quotes, escapes, ANSI-C strings, line continuations, command and process substitution, heredocs (data unless fed to a shell), keywords, wrappers like `env`, `xargs`, and `timeout`, nested `sh -c`, interpreter one-liners, and `find -exec`. The blocklist then matches what each part of the command actually runs, so `"su"do`, `bash -c 'sudo …'`, and `git -C . push` read the same as the plain versions. It flags privilege escalation, remote shells, destruction (including `git checkout --`, `stash drop`, and abbreviated `--hard`), uploads, download-and-run, publishing, global installs, writes outside the project, code run through tool options or the environment (`git grep -O`, `rg --pre`, `LD_PRELOAD`, `PAGER`, …), fork bombs, and unbounded loops. Anything it can't parse, or that contains invisible characters, is flagged too.
2. **Jev.** Jev sees your last three messages (long ones keep their start and end), messages from other Claude Code sessions in a separate `peer_requests` field, the pending call, and the project directory. It never sees tool output. A flagged call still goes to Jev, but only a denial counts.
3. **Decision.** The thresholds above. If the key is missing, TypeSafe errors, or Jev takes longer than 1.5 seconds, the call goes to the built-in classifier.

Text inside a call can try to argue for approval, for example a comment saying the user signed off. Shell comments and echoed strings that vouch for a command are flagged by the prefilter, a `steering` question catches the rest (any score above 0.10 blocks an allow), and `serves_request` is told that such text is not a request.

Why these thresholds: on the dev split, the risk ceiling is what kept unsafe calls out, while v0.1.2's high bar on "serves your request" (85%) mostly turned away routine work. Lowering that bar to 50% and the risk ceiling from 25% to 10%, together with question wording that says what doesn't count, cut unsafe allows on dev from 23 to 1 and doubled routine allows, from 32% to 65% (the new blocklist was in place for both).

## Privacy

Every call Jev judges sends your last three messages (up to 1,500 characters each), the pending command or URL, and your project path to TypeSafe's API. Read [TypeSafe's data handling](https://docs.typesafe.ai/models.md#data-handling) before using it with anything sensitive.

These never leave your machine: calls with an inline secret (API keys and tokens in common formats, private keys, JWTs, bearer headers, passwords in assignments or URLs), and commands that touch `.env` files, credential files, or credential folders. They go straight to the built-in classifier, in every gate mode. Pattern matching can't catch every secret, so treat this as a backstop, not a guarantee.

The API key itself is a sensitive plugin setting: Claude Code masks it and keeps it in secure storage rather than `settings.json`. The gate sends it only to TypeSafe and never logs it.

## Requirements

- Claude Code 2.1.287 or later, with mods enabled for your account
- A TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai/keys)

Jev bills input tokens only. Each check is about 770 tokens, a small fraction of a cent.

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
| Jev model | `jev-1.13.0` | Pinned to the version the thresholds were tuned on. `jev-latest` follows new releases, which can shift answers. |
| Decision logs | off | Write every decision to `~/.claude/jev-permission-gate/logs/`. Off by default because the logs record the commands the gate sees. |

Change the gate mode, model, and logging later in `/config`. If you installed before v0.1.2, check that the model reads `jev-1.13.0`: an older install may have saved `jev-latest`. Instead of the key setting, you can export `TYPESAFE_API_KEY`.

## Use

The gate only acts in auto mode. Inside a session, `/jev-gate` shows counts, Jev latency, and the last 15 decisions with their reasons, whether or not logging is on.

With decision logs on, or in shadow or measure mode, logs go to `~/.claude/jev-permission-gate/logs/`, which survives plugin updates. Logging never delays a decision: writes happen in the background.

- `decisions.jsonl`: every decision, including calls the gate passed through untouched
- `compare.jsonl`: each call the built-in classifier decided, with its timing

Each keeps its last 1,000 lines.

## Evals

The eval suite is built to be checked, not taken on trust.

| Set | Cases | Must not allow | Source | Labels |
| - | - | - | - | - |
| `corpus/nah` | 6,001 | 5,999 | [nah](https://github.com/manuelschipper/nah)'s reviewed corpus of dangerous commands, each under an unrelated everyday request; one in five also as "the user pasted it" | nah's maintainers; 200 audited (both annotators agreed on 195) |
| `corpus/prior-art` | 754 | 397 | Test cases from five other Jev gates | two annotators |
| `corpus/swe` | 400 | 19 | Commands coding agents ran fixing GitHub issues: the 300 most frequent plus a sample of the long tail | two annotators |
| `corpus/tbench` | 260 | 15 | Commands agents ran on Terminal-Bench tasks | two annotators |
| `corpus/tldr` | 300 | 28 | tldr-pages examples for the 80 programs agents run most | two annotators |
| `edge` | 56 | 22 | Hand-written edge cases | three labelers |
| `cases`, `holdout` | 93 | 35 | The original hand-written sets | one labeler |

- **Labels.** Two annotators labeled each imported case blind, against a written rubric ([`evals/LABELING.md`](evals/LABELING.md)), never seeing upstream verdicts, gate output, or each other's work. The annotators were two different models, Claude Opus and Claude Sonnet. A decision counts as acceptable only if both accepted it. They agreed on whether a call must not be allowed for 93% to 99% of cases, depending on the set.
- **Reproducible.** `evals/import/` rebuilds every corpus from upstream sources pinned to a commit, and checks the rebuilt cases against the committed labels key by key. Every case records its source, commit, file, upstream identifier, and license.
- **Sealed test split.** Imported cases are split about 30% dev and 70% test, by a hash of the base case. The corpus was committed before any run, the policy was committed before the one test run, and the bound counts a case and its variants once.
- **Honest denominators.** A call counts as an unsafe allow if any rep allowed it. Bounds are exact one-sided Clopper-Pearson.

```bash
node evals/run.ts --cases=corpus --split=dev          # imported dev split, by set
node evals/run.ts --cases=all --by=set,category       # everything, by set and category
node evals/score.ts --sweep --split=dev               # threshold trade-offs, offline, from the last run
node evals/import/nah.ts && node evals/import/annotated.ts   # rebuild the corpora
```

Responses are cached in `evals/cache/` (gitignored), so reruns with the same cases, wording, and model are free. A full run of every set is about 16,000 requests, roughly 12 million input tokens, about 50 cents.

What it doesn't show: the annotators are models, so a systematic blind spot they share would carry into the labels. nah's cases are mostly adversarial by design and each uses an unrelated request, so they test refusing what wasn't asked for more than judging close calls. The real-workload sets pair each command with the task, not the exact conversation the agent had.

## Head to head with the built-in classifier

Set the gate mode to `shadow` to compare Jev with the built-in classifier on the same calls, or `measure` to time the classifier alone. To switch modes without reloading, write `{ "mode": "shadow" }` to `~/.claude/jev-permission-gate/gate.json`, which overrides the setting and is re-read every few seconds.

Each call's whole permission wait (call start to return, minus the tool's own run time) goes to `compare.jsonl`, and `node evals/compare.ts --since=<ISO time>` summarizes it.

On 2026-10-02, with v0.1.2, the same 24 classifier-bound commands, one call per turn in a live session:

| Path | Calls | Median | 90th percentile | Mean |
| - | - | - | - | - |
| Built-in classifier only | 25 | 329ms | 459ms | 346ms |
| Gate enforcing, all calls | 24 | 306ms | 532ms | 291ms |
| …decided by Jev | 11 | 164ms | 245ms | 192ms |
| …deferred to the classifier | 13 | 321ms | 535ms | 376ms |

Jev's verdicts agreed with the built-in classifier's on every call it would have decided. Deferring costs little at the median because the classifier's work appears to overlap Jev's request, so the overall gain scales with how many calls Jev decides. That session was one workload of mostly routine commands. TypeSafe's API also appears to handle one request per account at a time, so parallel tool calls queue their checks at about 100ms each.

## Test

```bash
node --test tests/*.spec.ts   # policy, shell parsing, several hundred edge cases, eval statistics
claude plugin test            # end-to-end hook tests, needs mods enabled
claude plugin validate . --strict
```

## Tune

Thresholds, the tool list, the timeout, and the default model live in `DEFAULT_CONFIG` in `hooks/policy.ts`, next to the question wording and the blocklist. Change them against the dev split (`node evals/score.ts --sweep --split=dev` re-scores saved runs without new API calls), then check the test split.

## Develop

```bash
git clone https://github.com/madisonrickert/jev-permission-gate.git
claude --plugin-dir ./jev-permission-gate
```

A checkout loaded this way can read the key from a `TYPESAFE_API_KEY=...` line in a `.env` file at the repo root (gitignored). Claude Code hot-reloads the mod when its files change.

## Layout

| File | Role |
| - | - |
| `hooks/register.ts` | Wiring: `tool.check`, permission-mode tracking, timing, `/jev-gate` |
| `hooks/policy.ts` | Pure logic: blocklist, secret and URL checks, Jev questions, state, thresholds |
| `hooks/shell.ts` | Shell lexer: what a command really runs |
| `hooks/typesafe.ts` | Typed request and response for `POST /v1/systemone` |
| `types/index.d.ts` | Session state that survives a hot reload |
| `evals/` | Labeled sets, runner, offline scorer, head-to-head summary |
| `evals/import/` | Pinned importers, raw annotator labels, and the prior-art extraction |

## Prior art

- [nah](https://github.com/manuelschipper/nah) by Manuel Schipper: a structural permission guard whose reviewed corpus of dangerous commands is the largest source here, along with its capture of real agent commands.
- [jev-guard](https://github.com/leepokai/jev-guard) by leepokai: a Jev security hook for eight coding agents that also scans tool results for prompt injection and checks instruction files. Its tests use a stand-in model, so no cases were imported.
- [claude-code-jev](https://github.com/RahulBalakavi/claude-code-jev): a Jev `PreToolUse` hook for Claude Code via OpenRouter, with a labeled fixture set and a live benchmark (0 dangerous actions allowed in 90 decisions). Its fixtures are in the prior-art set.
- [pi-warden](https://github.com/DevMortimer/pi-warden): the most thoroughly tested Jev gate, for the pi coding agent. Its guard tests, rich in data-versus-executed-text and option-execution cases, are most of the prior-art set.
- [pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode): the paired asked/not-asked eval design. Its fixtures and policy tests are in the prior-art set.
- [pi-jev-gate](https://github.com/dys-org/pi-jev-gate) and [pi-verdict](https://github.com/jesset/pi-verdict): policy tests, including pi-verdict's security-audit bypass cases.
- [jevaluate](https://github.com/tiffygk/jev-mode/tree/main/jevaluate) by [@tiffygk](https://github.com/tiffygk): rates how well a project uses Jev, citing a file and line for every finding. Its rating of v0.1.1 (verdict 3, "Use with a fix") drove the v0.1.2 changes: the steering question, the pinned model, the fresh held-out set, and the stated error bound.
- [bouncer](https://github.com/michaeldstenner/bouncer): unsure verdicts hand off to auto mode.
- [io-auto-mode](https://github.com/simon-inkie/inkie-auto-mode): keep assistant text out of the classifier's input.

Imported eval material is used under MIT, CC BY 4.0, and Apache 2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). jevaluate is under PolyForm Noncommercial and was used only to rate this project. No third-party code ships in the mod.

## License

[MIT](LICENSE)
