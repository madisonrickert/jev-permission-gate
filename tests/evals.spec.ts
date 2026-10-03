import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG } from '../hooks/policy.ts'
import { listSets, loadSet, splitFor, validateSet } from '../evals/lib/cases.ts'
import { metrics, score, type Row } from '../evals/lib/score.ts'
import { upperBound } from '../evals/lib/stats.ts'

test('upperBound matches the closed form at zero failures and the rule of three', () => {
  for (const n of [10, 35, 300, 1000]) {
    assert.ok(Math.abs(upperBound(0, n) - (1 - Math.pow(0.05, 1 / n))) < 1e-9)
  }
  assert.ok(Math.abs(upperBound(0, 300) - 3 / 300) < 0.0005)
  // Known value: 1 failure in 100 gives about 4.66% at 95%.
  assert.ok(Math.abs(upperBound(1, 100) - 0.0466) < 0.0005)
  assert.equal(upperBound(0, 0), 1)
})

test('every case set is valid and ids are unique across sets', () => {
  const seen = new Set<string>()
  const problems = listSets().flatMap((s) => validateSet(loadSet(s), seen))
  assert.deepEqual(problems, [])
})

test('splitFor is stable and roughly 30/70', () => {
  assert.equal(splitFor('atomic-T1003.008-1'), splitFor('atomic-T1003.008-1'))
  const ids = Array.from({ length: 2000 }, (_, i) => `case-${i}`)
  const dev = ids.filter((id) => splitFor(id) === 'dev').length / ids.length
  assert.ok(dev > 0.25 && dev < 0.35, `dev share ${dev}`)
})

const row = (over: Partial<Row>): Row => ({
  set: 's',
  variant: 'shipped',
  rep: 0,
  id: 'x',
  base: 'x',
  ok: ['deny', 'defer'],
  ideal: 'deny',
  category: 'c',
  source: 'hand-written',
  split: 'test',
  nouls: { serves_request: 0.95, destructive: 0, external_effect: 0, exfiltration: 0, credentials: 0, escalation: 0, outside_project: 0, steering: 0 },
  ms: 100,
  tokens: 700,
  model: 'jev-1.13.0',
  ...over,
})

test('metrics count a risky base case once across reps and variants, and the blocklist overrides Jev', () => {
  const rows = [
    row({ id: 'a', base: 'a', rep: 0 }),
    row({ id: 'a', base: 'a', rep: 1 }),
    row({ id: 'a2', base: 'a', rep: 0 }),
    row({ id: 'b', base: 'b', blocklisted: 'sudo' }),
  ]
  const m = metrics(score(rows, DEFAULT_CONFIG))
  assert.equal(m.risky, 2)
  assert.deepEqual(m.unsafeAllowCases, ['a'])
  assert.equal(m.unsafeAllowRows, 3)
  assert.deepEqual(m.jevOnlyUnsafeAllowCases, ['a', 'b'])
})

test('metrics flag wrong denies and rep flips', () => {
  const deny = { serves_request: 0.1, destructive: 0.95 }
  const rows = [
    row({ id: 'w', base: 'w', ok: ['allow', 'defer'], ideal: 'allow', nouls: { ...row({}).nouls, ...deny } }),
    row({ id: 'f', base: 'f', rep: 0, ok: ['allow', 'defer'], ideal: 'allow' }),
    row({ id: 'f', base: 'f', rep: 1, ok: ['allow', 'defer'], ideal: 'allow', nouls: { ...row({}).nouls, serves_request: 0.5 } }),
  ]
  const m = metrics(score(rows, DEFAULT_CONFIG))
  assert.deepEqual(m.wrongDenyCases, ['w'])
  assert.deepEqual(m.flippedCases, ['s/f/shipped'])
  assert.equal(m.allowedWhenIdeal, 1)
})
