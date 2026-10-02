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
// eval can read what happened without asking anyone to run /jev-gate. Mods
// have no append, so we hold the tail in memory and rewrite the file, one
// write at a time and never in the tool call's path.
const LOG_LIMIT = 1000
let journal: string[] | undefined
let journalWrite: Promise<void> = Promise.resolve()

function journalAppend($: EngineInterface, entry: LogEntry) {
  const line = JSON.stringify({ at: new Date().toISOString(), mode: permissionMode ?? null, peers: peerRequests.length, ...entry })
  const path = `${$.plugin.root}/logs/decisions.jsonl`
  journalWrite = journalWrite
    .then(async () => {
      if (!journal) {
        // First write since this module loaded: keep what an earlier load wrote.
        journal = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(Boolean) : []
      }
      journal.push(line)
      if (journal.length > LOG_LIMIT) journal.splice(0, journal.length - LOG_LIMIT)
      await $.fs.write(path, journal.join('\n') + '\n')
    })
    .catch(() => {
      // Logging must never affect a permission decision.
    })
}

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

// The key comes from the environment, or else from a .env file beside the
// mod's manifest. A found key is kept; a missing one is looked up again on
// the next call, so adding the file later works without a reload.
let apiKeyCache: string | undefined

async function loadApiKey($: EngineInterface): Promise<string | undefined> {
  if (apiKeyCache) return apiKeyCache
  apiKeyCache = await $.env.get('TYPESAFE_API_KEY')
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

export const register: Register = (on) => {
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
    await rememberMode($, e.permission_mode)
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    // What rules, settings hooks and the mode decided. Only an `ask` in auto
    // mode would reach the classifier, so that's the only case we touch.
    const decided = await next(e)
    permissionMode = (await read($, modeAtom)) ?? undefined
    peerRequests = await read($, peersAtom)
    const summary = JSON.stringify(e.input ?? {}).slice(0, 120)
    if (decided.decision !== 'ask' || permissionMode !== 'auto' || !e.tool_use_id) {
      if (e.tool_use_id) {
        const why = decided.decision !== 'ask' ? `engine already decided ${decided.decision}` : `mode ${permissionMode ?? 'unknown'}`
        record($, { outcome: 'passthrough', tool: e.tool, summary, reason: why })
      }
      return decided
    }

    const gate = prefilter(e.tool, e.input, config)
    if (!gate.ok) {
      record($, { outcome: 'skipped', tool: e.tool, summary, reason: gate.reason })
      return decided
    }

    const apiKey = await loadApiKey($)
    if (!apiKey) {
      if (!warnedNoKey) {
        warnedNoKey = true
        $.ui.log('jev-permission-gate: no TYPESAFE_API_KEY in the environment or the mod\'s .env, so every call goes to the built-in classifier')
      }
      record($, { outcome: 'skipped', tool: e.tool, summary, reason: 'no TYPESAFE_API_KEY' })
      return decided
    }
    const model = (await $.env.get('TYPESAFE_DEFAULT_MODEL')) || config.model

    const messages = await $.session.messages()
    const userRequests = messages.filter((m) => m.role === 'user' && m.text.trim()).map((m) => m.text)
    const cwd = await $.session.cwd()
    const state = buildState(userRequests, gate.action, cwd, peerRequests)

    const cacheKey = JSON.stringify(state)
    const cached = cache.get(cacheKey)
    if (cached) {
      record($, { outcome: OUTCOME[cached.decision], tool: e.tool, summary, reason: `cached: ${cached.reason}`, ms: 0 })
      return answer(cached, `${model} (cached)`, decided)
    }

    const started = await $.clock.now()
    try {
      const result = await Promise.race([askJev($, apiKey, state, model), timeout($, config.timeoutMs)])
      const ms = (await $.clock.now()) - started
      if (result === 'timeout') {
        record($, { outcome: 'error', tool: e.tool, summary, reason: `timed out after ${config.timeoutMs}ms`, ms })
        return decided
      }
      const verdict = decide(result.answers, config)
      remember(cacheKey, verdict)
      record($, { outcome: OUTCOME[verdict.decision], tool: e.tool, summary, reason: verdict.reason, ms })
      return answer(verdict, result.model, decided)
    } catch (err) {
      const ms = (await $.clock.now()) - started
      record($, { outcome: 'error', tool: e.tool, summary, reason: String((err as Error)?.message ?? err), ms })
      return decided
    }
  })

  on('command.run', { command: 'jev-gate' }, async () => {
    const lines = [
      `mode: ${permissionMode ?? 'unknown (gate idle until the first prompt)'}`,
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
