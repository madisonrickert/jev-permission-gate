// Compare Jev with Claude Code's built-in auto mode classifier on the same
// live calls, from ~/.claude/jev-permission-gate/logs/compare.jsonl.
//
//   node evals/compare.ts [--since=2026-10-02T23:00] [--log=path/to/compare.jsonl]
//
// In shadow mode the classifier decides every call and Jev's verdict is only
// logged, so each row pairs the two on one call. "Enforce" projects what the
// same calls would cost with the gate acting on Jev: an allow or deny skips
// the classifier, a defer pays for both.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

type Row = {
  at: string
  gate: string
  tool: string
  summary: string
  jev: { decision: 'allow' | 'deny' | 'defer'; ms: number; reason: string; blocklisted?: string } | null
  skipped: string | null
  classifier: { decision: 'allow' | 'deny'; ms: number; reason: string | null } | null
  decider?: 'jev' | 'classifier' | 'engine'
  permission_ms?: number
  run_ms: number | null
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const all = readFileSync(String(args.log ?? `${homedir()}/.claude/jev-permission-gate/logs/compare.jsonl`), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row)
  .filter((r) => !args.since || r.at >= String(args.since))
const rows = all.filter((r) => r.gate === 'shadow' && r.jev && r.classifier)

// End to end: the whole permission wait per call, measure mode (classifier
// only) against enforce mode (Jev first), on the same workload.
{
  const q1 = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0
  const m1 = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length))
  const e2e = (pred: (r: Row) => boolean) => all.filter((r) => r.permission_ms !== undefined && r.decider !== 'engine' && pred(r)).map((r) => r.permission_ms!)
  const base = e2e((r) => r.gate === 'measure')
  const enf = e2e((r) => r.gate === 'enforce')
  const enfJev = e2e((r) => r.gate === 'enforce' && r.decider === 'jev')
  const enfDef = e2e((r) => r.gate === 'enforce' && r.decider === 'classifier')
  if (base.length && enf.length) {
    const line = (n: string, xs: number[]) => console.log(`${n.padEnd(38)} ${String(xs.length).padStart(3)} calls · p50 ${q1(xs, 0.5)}ms · p90 ${q1(xs, 0.9)}ms · mean ${m1(xs)}ms`)
    console.log('End to end, whole permission wait per call')
    line('  classifier only (measure)', base)
    line('  gate enforcing (all)', enf)
    line('    decided by Jev', enfJev)
    line('    deferred to the classifier', enfDef)
    console.log(`  mean change: ${m1(enf) - m1(base)}ms per call (${Math.round((100 * (m1(enf) - m1(base))) / m1(base))}%)\n`)
  }
}

if (!rows.length) {
  console.log('No shadow-mode rows with a Jev verdict yet.')
  process.exit(0)
}

const q0 = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0
const measured = all.filter((r) => r.skipped === 'measure mode' && r.classifier).map((r) => r.classifier!.ms)
const control = all.filter((r) => r.skipped?.startsWith('control') && r.classifier).map((r) => r.classifier!.ms)
if (measured.length) console.log(`Classifier alone (measure mode, no Jev): ${measured.length} calls · p50 ${q0(measured, 0.5)}ms · p90 ${q0(measured, 0.9)}ms`)
if (control.length) console.log(`Control (engine allowed, no classifier):  ${control.length} calls · p50 ${q0(control, 0.5)}ms · p90 ${q0(control, 0.9)}ms`)
if (measured.length || control.length) console.log('')

const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
const fmt = (xs: number[]) => `p50 ${q(xs, 0.5)}ms · p90 ${q(xs, 0.9)}ms · mean ${Math.round(mean(xs))}ms`

const jevMs = rows.map((r) => r.jev!.ms)
const clsMs = rows.map((r) => r.classifier!.ms)
console.log(`${rows.length} paired calls\n`)
console.log(`Jev                ${fmt(jevMs)}`)
console.log(`Built-in classifier ${fmt(clsMs)}`)
console.log(`Classifier ÷ Jev, per call: median ${q(rows.map((r) => r.classifier!.ms / Math.max(1, r.jev!.ms)), 0.5).toFixed(1)}×\n`)

const matrix: Record<string, number> = {}
for (const r of rows) matrix[`${r.jev!.decision}/${r.classifier!.decision}`] = (matrix[`${r.jev!.decision}/${r.classifier!.decision}`] ?? 0) + 1
console.log('Jev (rows) vs classifier (columns)')
console.log('            allow  deny')
for (const j of ['allow', 'defer', 'deny']) {
  console.log(`  ${j.padEnd(8)} ${String(matrix[`${j}/allow`] ?? 0).padStart(6)} ${String(matrix[`${j}/deny`] ?? 0).padStart(5)}`)
}

// Projected permission-check time per call, today vs with the gate enforcing.
const today = clsMs
const enforced = rows.map((r) => (r.jev!.decision === 'defer' ? r.jev!.ms + r.classifier!.ms : r.jev!.ms))
const decidedByJev = rows.filter((r) => r.jev!.decision !== 'defer').length
console.log(`\nJev would decide ${decidedByJev} of ${rows.length} calls (${Math.round((100 * decidedByJev) / rows.length)}%); the rest pay for both.`)
console.log(`Permission time per call today:     ${fmt(today)}`)
console.log(`Permission time per call, enforced: ${fmt(enforced)}`)
const saved = today.reduce((s, x) => s + x, 0) - enforced.reduce((s, x) => s + x, 0)
console.log(`Total saved over these calls: ${(saved / 1000).toFixed(1)}s (${Math.round((100 * saved) / today.reduce((s, x) => s + x, 0))}% of permission time)`)

const unsafe = rows.filter((r) => r.jev!.decision === 'allow' && r.classifier!.decision === 'deny')
const stricter = rows.filter((r) => r.jev!.decision === 'deny' && r.classifier!.decision === 'allow')
console.log(`\nJev allow where the classifier denied: ${unsafe.length}`)
for (const r of unsafe) console.log(`  ${r.summary}\n    classifier: ${r.classifier!.reason}\n    jev: ${r.jev!.reason}`)
console.log(`Jev deny where the classifier allowed: ${stricter.length}`)
for (const r of stricter) console.log(`  ${r.summary}\n    jev: ${r.jev!.reason}`)
