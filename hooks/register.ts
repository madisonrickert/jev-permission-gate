// jev-permission-gate: let TypeSafe's Jev decide routine tool calls in auto
// mode. Jev allows what it's clearly sure is fine, denies what it's clearly
// sure is wrong, and hands everything in between to the built-in classifier.

import {
  buildState,
  decide,
  DEFAULT_CONFIG,
  prefilter,
  QUESTION_KEYS,
  QUESTIONS,
  type GateConfig,
  type Verdict,
} from './policy.ts'
import { atom, read, update, type EngineInterface, type Register } from 'claude-code'
import {
  parseNoulResponse,
  readDotenvValue,
  SYSTEM_ONE_URL,
  type JsonValue,
  type SystemOneRequest,
} from './typesafe.ts'

type Outcome = 'allowed' | 'denied' | 'deferred' | 'skipped' | 'error' | 'passthrough'
type LogEntry = { outcome: Outcome | 'received'; tool: string; summary: string; reason: string; ms?: number }

// Every decision also goes to logs/decisions.jsonl beside the manifest, so an
// eval can read what happened without asking anyone to run /jev-gate, and each
// call the built-in classifier decided goes to logs/compare.jsonl. Mods have no
// append, so each journal holds its tail in memory and rewrites the file, one
// write at a time and never in the tool call's path.
const LOG_LIMIT = 1000

// An installed plugin runs from a cache folder that each update replaces, so
// logs and gate.json live here instead: ~/.claude/jev-permission-gate/.
let dataDir: string | undefined

async function loadDataDir($: EngineInterface): Promise<string> {
  dataDir ??= `${(await $.env.get('HOME')) ?? '.'}/.claude/jev-permission-gate`
  return dataDir
}

type JournalFile = 'decisions.jsonl' | 'compare.jsonl'
const journals = new Map<JournalFile, { lines?: string[]; writing: Promise<void> }>()

// Logs record the commands the gate sees, so they're opt-in: the
// decision_logs setting turns them on, and shadow and measure modes, whose
// purpose is the comparison log, always write them.
let decisionLogs = false
const loggingOn = () => decisionLogs || gateMode !== 'enforce'

function appendJournal($: EngineInterface, file: JournalFile, row: Record<string, unknown>) {
  if (!loggingOn()) return
  const journal = journals.get(file) ?? { writing: Promise.resolve() }
  journals.set(file, journal)
  const line = JSON.stringify({ at: new Date().toISOString(), ...row })
  journal.writing = journal.writing
    .then(async () => {
      const path = `${await loadDataDir($)}/logs/${file}`
      // First write since this module loaded: keep what an earlier load wrote.
      journal.lines ??= (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(Boolean) : []
      journal.lines.push(line)
      if (journal.lines.length > LOG_LIMIT) journal.lines.splice(0, journal.lines.length - LOG_LIMIT)
      await $.fs.write(path, journal.lines.join('\n') + '\n')
    })
    .catch(() => {
      // Logging must never affect a permission decision.
    })
}

function journalAppend($: EngineInterface, entry: LogEntry) {
  appendJournal($, 'decisions.jsonl', { mode: permissionMode ?? null, peers: peerRequests.length, gate: gateMode, ...entry })
}

// The mode comes from the plugin's gate_mode setting (/config), and a
// gate.json in the data directory overrides it, which lets an eval switch
// modes without a reload.
// `enforce` (the default) acts on Jev's verdicts. `shadow` asks Jev about
// every eligible call, blocklisted ones included, logs what it would have
// done, and always hands the call to the built-in classifier, so the two can
// be compared on the same calls. `measure` never asks Jev and only times the
// built-in classifier, so Jev's own request can't overlap with it. Set it with {"mode": "shadow"} in gate.json
// beside the manifest; the file is re-read every few seconds.
type GateMode = 'enforce' | 'shadow' | 'measure'
const GATE_MODES: readonly GateMode[] = ['enforce', 'shadow', 'measure']
const asGateMode = (value: unknown): GateMode | undefined => GATE_MODES.find((m) => m === value)
let configuredGateMode: GateMode = 'enforce'
let gateMode: GateMode = 'enforce'
let gateModeReadAt = -Infinity

async function loadGateMode($: EngineInterface): Promise<GateMode> {
  const now = await $.clock.now()
  if (now - gateModeReadAt < 5000) return gateMode
  gateModeReadAt = now
  try {
    const parsed = JSON.parse(await $.fs.read(`${await loadDataDir($)}/gate.json`)) as { mode?: unknown }
    gateMode = asGateMode(parsed.mode) ?? configuredGateMode
  } catch {
    gateMode = configuredGateMode
  }
  return gateMode
}

// Calls handed to the built-in classifier, by tool_use_id, so tool.call can
// time the classifier once the call returns. There is no event between the
// classifier's verdict and the tool starting, so its time is the span from
// the hand-off to the call's return, minus the tool's own run time, which
// PostToolUse reports.
type Handoff = {
  tool: string
  summary: string
  handedOffAt: number
  jev?: { decision: Verdict['decision']; ms: number; reason: string; blocklisted?: string }
  skippedBecause?: string
}
const handoffs = new Map<string, Handoff>()
const runTimes = new Map<string, number>()
// Calls Jev decided itself in enforce mode, for the end-to-end comparison.
const jevDecided = new Map<string, { tool: string; summary: string; jev: NonNullable<Handoff['jev']> }>()

const config: GateConfig = { ...DEFAULT_CONFIG }

// Mods have no direct getter for the permission mode, so we read it off the
// classic hook inputs. Until we've seen one, the gate stays out of the way.
// It and the peer requests live in $.state, which outlives a hot reload; the
// module variables are copies refreshed at each check, used for logging.
const modeAtom = atom({ plugin: 'jev-permission-gate', key: 'mode' } as const, null)
const peersAtom = atom({ plugin: 'jev-permission-gate', key: 'peers' } as const, [])
let permissionMode: string | undefined

// Messages from other sessions (and Remote Control) arrive through
// session.receive, not the transcript, so we keep the last few.
let peerRequests: readonly string[] = []

const counts: Record<Outcome, number> = { allowed: 0, denied: 0, deferred: 0, skipped: 0, error: 0, passthrough: 0 }
const latencies: number[] = []
const recent: LogEntry[] = []
const cache = new Map<string, Verdict>()
let warnedNoKey = false

const OUTCOME: Record<Verdict['decision'], Outcome> = { allow: 'allowed', deny: 'denied', defer: 'deferred' }

function record($: EngineInterface, entry: LogEntry & { outcome: Outcome }) {
  journalAppend($, entry)
  counts[entry.outcome] += 1
  if (entry.ms !== undefined) {
    latencies.push(entry.ms)
    if (latencies.length > 500) latencies.shift()
  }
  recent.push(entry)
  if (recent.length > 15) recent.shift()
}

function remember(key: string, verdict: Verdict) {
  cache.set(key, verdict)
  if (cache.size > 300) cache.delete(cache.keys().next().value as string)
}

/** Turn a verdict into what tool.check returns; `defer` keeps the engine's own decision. */
function answer(verdict: Verdict, model: string, decided: { decision: 'allow' | 'ask' | 'deny' }) {
  if (verdict.decision === 'allow') return { decision: 'allow' as const, reason: `Jev ${model}: ${verdict.reason}` }
  if (verdict.decision === 'deny') {
    return { decision: 'deny' as const, reason: `Blocked by the Jev permission gate (${verdict.reason}).` }
  }
  return decided
}

// The key comes from the plugin's typesafe_api_key setting (kept in secure
// storage), else the environment, else a .env file beside the manifest, which
// suits a checkout loaded with --plugin-dir. A found key is kept; a missing
// one is looked up again on the next call.
let configuredApiKey: string | undefined
let configuredModel: string | undefined
let apiKeyCache: string | undefined

async function loadApiKey($: EngineInterface): Promise<string | undefined> {
  if (apiKeyCache) return apiKeyCache
  apiKeyCache = configuredApiKey || (await $.env.get('TYPESAFE_API_KEY'))
  if (!apiKeyCache) {
    try {
      apiKeyCache = readDotenvValue(await $.fs.read(`${$.plugin.root}/.env`), 'TYPESAFE_API_KEY')
    } catch {
      // No .env file: leave the key unset.
    }
  }
  return apiKeyCache
}

async function askJev($: EngineInterface, apiKey: string, state: JsonValue, model: string) {
  const body: SystemOneRequest<(typeof QUESTION_KEYS)[number]> = { model, state, questions: QUESTIONS }
  const res = await $.http.fetch(SYSTEM_ONE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${res.text.slice(0, 200)}`)
  return parseNoulResponse(JSON.parse(res.text), QUESTION_KEYS)
}

async function timeout($: EngineInterface, ms: number): Promise<'timeout'> {
  await $.clock.sleep(ms)
  return 'timeout'
}

async function rememberMode($: EngineInterface, mode: string | undefined) {
  if (!mode || mode === permissionMode) return
  permissionMode = mode
  await update($, modeAtom, () => mode)
}

function percentile(values: readonly number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export const register: Register = (on, options) => {
  const option = (key: string) => (typeof options[key] === 'string' && (options[key] as string).trim()) || undefined
  configuredApiKey = option('typesafe_api_key')
  configuredModel = option('model')
  configuredGateMode = asGateMode(option('gate_mode')) ?? 'enforce'
  decisionLogs = options.decision_logs === true
  gateMode = configuredGateMode

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev-gate',
      description: 'Show what the Jev permission gate allowed, denied, and deferred this session',
    })
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (e.text.trim()) {
      peerRequests = await update($, peersAtom, (list) => [...(list ?? []), e.text].slice(-3))
    }
    journalAppend($, { outcome: 'received', tool: '-', summary: e.text.slice(0, 120), reason: `origin ${e.origin.kind}` })
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await rememberMode($, e.permission_mode)
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    if ((handoffs.has(e.tool_use_id) || jevDecided.has(e.tool_use_id)) && e.duration_ms !== undefined) {
      runTimes.set(e.tool_use_id, e.duration_ms)
    }
    await rememberMode($, e.permission_mode)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // permission_ms: the whole wait from the call starting to it returning,
    // minus the tool's own run time. The same measure in every gate mode, so
    // runs in `measure` and `enforce` compare end to end.
    const calledAt = await $.clock.now()
    const result = await next(e)
    const handoff = handoffs.get(e.tool_use_id)
    const decidedByJev = jevDecided.get(e.tool_use_id)
    if (!handoff && !decidedByJev) return result
    handoffs.delete(e.tool_use_id)
    jevDecided.delete(e.tool_use_id)
    const returnedAt = await $.clock.now()
    const runMs = runTimes.get(e.tool_use_id)
    runTimes.delete(e.tool_use_id)
    const denied = result.deny !== undefined
    const permissionMs = returnedAt - calledAt - (runMs ?? 0)
    appendJournal($, 'compare.jsonl', {
      gate: gateMode,
      tool: e.tool,
      summary: (handoff ?? decidedByJev)!.summary,
      jev: handoff?.jev ?? decidedByJev?.jev ?? null,
      skipped: handoff?.skippedBecause ?? null,
      // Who settled the call: Jev on its own, or the built-in classifier.
      decider: decidedByJev ? 'jev' : handoff?.skippedBecause?.startsWith('control') ? 'engine' : 'classifier',
      classifier: handoff
        ? {
            decision: denied ? 'deny' : 'allow',
            // Without a run time (a denial, or no PostToolUse), the span is all classifier.
            ms: returnedAt - handoff.handedOffAt - (runMs ?? 0),
            reason: denied ? String(result.deny).slice(0, 200) : null,
          }
        : null,
      permission_ms: permissionMs,
      run_ms: runMs ?? null,
    })
    return result
  })

  on('tool.check', async ($, e, next) => {
    // What rules, settings hooks and the mode decided. Only an `ask` in auto
    // mode would reach the classifier, so that's the only case we touch.
    const decided = await next(e)
    permissionMode = (await read($, modeAtom)) ?? undefined
    peerRequests = await read($, peersAtom)
    const summary = JSON.stringify(e.input ?? {}).slice(0, 120)
    const mode = await loadGateMode($)
    const handOff = async (h: Omit<Handoff, 'handedOffAt' | 'tool' | 'summary'>) => {
      if (loggingOn()) handoffs.set(e.tool_use_id!, { tool: e.tool, summary, handedOffAt: await $.clock.now(), ...h })
      return decided
    }
    if (decided.decision !== 'ask' || permissionMode !== 'auto' || !e.tool_use_id) {
      if (e.tool_use_id) {
        const why = decided.decision !== 'ask' ? `engine already decided ${decided.decision}` : `mode ${permissionMode ?? 'unknown'}`
        record($, { outcome: 'passthrough', tool: e.tool, summary, reason: why })
        // Control rows: the same timing on calls no classifier sees, which
        // gives the overhead floor the classifier's figures include.
        if (mode !== 'enforce' && decided.decision === 'allow' && permissionMode === 'auto') {
          return handOff({ skippedBecause: 'control: engine allowed without the classifier' })
        }
      }
      return decided
    }

    if (mode === 'measure') {
      record($, { outcome: 'skipped', tool: e.tool, summary, reason: 'measure mode: classifier only' })
      return handOff({ skippedBecause: 'measure mode' })
    }
    const shadow = mode === 'shadow'

    const gate = prefilter(e.tool, e.input, config)
    if (!gate.ok && !(shadow && config.tools.includes(e.tool))) {
      record($, { outcome: 'skipped', tool: e.tool, summary, reason: gate.reason })
      return handOff({ skippedBecause: gate.reason })
    }
    const action = gate.ok ? gate.action : { tool: e.tool, input: e.input as JsonValue }
    const blocklisted = gate.ok ? undefined : gate.reason

    const apiKey = await loadApiKey($)
    if (!apiKey) {
      if (!warnedNoKey) {
        warnedNoKey = true
        $.ui.log('jev-permission-gate: no TypeSafe API key (set it with /plugin, TYPESAFE_API_KEY, or a .env), so every call goes to the built-in classifier')
      }
      record($, { outcome: 'skipped', tool: e.tool, summary, reason: 'no TYPESAFE_API_KEY' })
      return handOff({ skippedBecause: 'no TYPESAFE_API_KEY' })
    }
    const model = configuredModel || (await $.env.get('TYPESAFE_DEFAULT_MODEL')) || config.model

    const messages = await $.session.messages()
    const userRequests = messages.filter((m) => m.role === 'user' && m.text.trim()).map((m) => m.text)
    const cwd = await $.session.cwd()
    const state = buildState(userRequests, action, cwd, peerRequests)

    // Shadow mode skips the cache so every comparison times a real request.
    const cacheKey = JSON.stringify(state)
    const cached = shadow ? undefined : cache.get(cacheKey)
    if (cached) {
      record($, { outcome: OUTCOME[cached.decision], tool: e.tool, summary, reason: `cached: ${cached.reason}`, ms: 0 })
      if (cached.decision === 'defer') return handOff({ jev: { decision: 'defer', ms: 0, reason: `cached: ${cached.reason}` } })
      return answer(cached, `${model} (cached)`, decided)
    }

    const started = await $.clock.now()
    try {
      const result = await Promise.race([askJev($, apiKey, state, model), timeout($, config.timeoutMs)])
      const ms = (await $.clock.now()) - started
      if (result === 'timeout') {
        record($, { outcome: 'error', tool: e.tool, summary, reason: `timed out after ${config.timeoutMs}ms`, ms })
        return handOff({ skippedBecause: `Jev timed out after ${config.timeoutMs}ms` })
      }
      const verdict = decide(result.answers, config)
      if (!shadow) remember(cacheKey, verdict)
      const reason = blocklisted ? `${verdict.reason} [blocklisted: ${blocklisted}]` : verdict.reason
      record($, { outcome: shadow ? 'deferred' : OUTCOME[verdict.decision], tool: e.tool, summary, reason: shadow ? `shadow, Jev would ${verdict.decision}: ${reason}` : reason, ms })
      if (shadow || verdict.decision === 'defer') {
        return handOff({ jev: { decision: blocklisted ? 'defer' : verdict.decision, ms, reason, blocklisted } })
      }
      if (loggingOn()) jevDecided.set(e.tool_use_id, { tool: e.tool, summary, jev: { decision: verdict.decision, ms, reason } })
      return answer(verdict, result.model, decided)
    } catch (err) {
      const ms = (await $.clock.now()) - started
      record($, { outcome: 'error', tool: e.tool, summary, reason: String((err as Error)?.message ?? err), ms })
      return handOff({ skippedBecause: 'Jev error' })
    }
  })

  on('command.run', { command: 'jev-gate' }, async () => {
    const lines = [
      `mode: ${permissionMode ?? 'unknown (gate idle until the first prompt)'} · gate: ${gateMode}`,
      `allowed ${counts.allowed} · denied ${counts.denied} · deferred ${counts.deferred} · skipped ${counts.skipped} · errors ${counts.error} · passed through ${counts.passthrough}`,
      `Jev latency p50 ${percentile(latencies, 50)}ms · p95 ${percentile(latencies, 95)}ms`,
      ...recent
        .slice()
        .reverse()
        .map((r) => `  ${r.outcome.padEnd(8)} ${r.tool} ${r.summary} — ${r.reason}${r.ms !== undefined ? ` (${r.ms}ms)` : ''}`),
    ]
    return { text: lines.join('\n') }
  })
}
