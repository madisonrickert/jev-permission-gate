// Labeled eval cases: the format, loading, and validation shared by the
// runner, the offline scorer, the importers, and the tests.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

export type Decision = 'allow' | 'defer' | 'deny'
export const DECISIONS: readonly Decision[] = ['allow', 'defer', 'deny']

/** Licenses whose material may be copied into this MIT repo with attribution. */
export const IMPORTABLE_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', 'CC0-1.0'] as const

export type Source = {
  /** Short name shown in reports, e.g. "atomic-red-team". */
  name: string
  /** Upstream repository or dataset URL. */
  url: string
  /** Commit or version the case was taken from. */
  commit: string
  /** File inside the upstream repository. */
  path: string
  /** Upstream identifier: fixture id, test name, or technique and test number. */
  ref: string
  license: (typeof IMPORTABLE_LICENSES)[number]
  /** The upstream verdict, verbatim, when there was one. */
  label?: string
}

export type Case = {
  id: string
  /** The user's recent messages, oldest first. A string is one message. */
  request: string | string[]
  /** Messages from other Claude Code sessions, if any. */
  peer?: string[]
  tool: string
  input: Record<string, unknown>
  /** Overrides the set's project directory for this case. */
  project_directory?: string
  /** Every decision that would be acceptable. */
  ok: Decision[]
  /** The best decision. Must be in `ok`. */
  ideal: Decision
  why: string
  /** Coarse grouping for the report, e.g. "exfiltration" or "routine". */
  category?: string
  /** Where an imported case came from. Hand-written cases have none. */
  source?: Source
  /** Cases generated from another case (e.g. with steering text added) name it here, so the bound counts them once. */
  base?: string
  /** For imported corpora: dev cases may inform changes; test cases are only ever scored. */
  split?: 'dev' | 'test'
}

export type CaseSet = {
  name: string
  project_directory: string
  note?: string
  cases: Case[]
}

const ROOT = new URL('../..', import.meta.url).pathname

/** Hand-written sets live in evals/; imported corpora in evals/corpus/. */
export function setPath(name: string): string {
  return `${ROOT}evals/${name}.json`
}

export function listSets(): string[] {
  const hand = ['cases', 'holdout', 'holdout-v1', 'edge']
  const corpus = readdirSync(`${ROOT}evals/corpus`)
    .filter((f) => f.endsWith('.json'))
    .map((f) => `corpus/${f.replace(/\.json$/, '')}`)
    .sort()
  return [...hand, ...corpus]
}

export function loadSet(name: string): CaseSet {
  const raw = JSON.parse(readFileSync(setPath(name), 'utf8')) as Omit<CaseSet, 'name'>
  return { name, ...raw }
}

/** Expand a --cases argument: "all", "corpus", or a comma list of set names. Retired sets are only included by name. */
export function resolveSets(arg: string | undefined): string[] {
  const all = listSets()
  if (!arg) return ['cases']
  if (arg === 'all') return all.filter((s) => s !== 'holdout-v1')
  if (arg === 'corpus') return all.filter((s) => s.startsWith('corpus/'))
  return arg.split(',').map((s) => {
    const name = all.includes(s) ? s : all.includes(`corpus/${s}`) ? `corpus/${s}` : undefined
    if (!name) throw new Error(`unknown case set ${s}; known: ${all.join(', ')}`)
    return name
  })
}

export const requests = (c: Case): string[] => (Array.isArray(c.request) ? c.request : [c.request])

/** A call the gate must never allow. These are the cases the unsafe-allow bound is computed over. */
export const mustNotAllow = (c: Case) => !c.ok.includes('allow')

/**
 * Deterministic dev/test split, keyed on the base case so a case and its
 * variants always land together. About 30% dev, 70% test.
 */
export function splitFor(baseId: string): 'dev' | 'test' {
  const h = createHash('sha256').update(baseId).digest()
  return h[0]! % 10 < 3 ? 'dev' : 'test'
}

/** Problems with a set, as human-readable strings. Empty means valid. */
export function validateSet(set: CaseSet, seenIds = new Set<string>()): string[] {
  const problems: string[] = []
  const ids = new Set(set.cases.map((c) => c.id))
  if (!set.project_directory?.startsWith('/')) problems.push(`${set.name}: project_directory must be absolute`)
  for (const c of set.cases) {
    const at = `${set.name}/${c.id}`
    if (!c.id) problems.push(`${set.name}: case without id`)
    if (seenIds.has(c.id)) problems.push(`${at}: duplicate id`)
    seenIds.add(c.id)
    if (!requests(c).length || requests(c).some((r) => typeof r !== 'string' || !r.trim())) problems.push(`${at}: empty request`)
    if (c.project_directory !== undefined && !c.project_directory.startsWith('/')) problems.push(`${at}: project_directory must be absolute`)
    if (typeof c.tool !== 'string' || !c.tool) problems.push(`${at}: missing tool`)
    if (typeof c.input !== 'object' || c.input === null) problems.push(`${at}: input must be an object`)
    if (!Array.isArray(c.ok) || !c.ok.length || c.ok.some((d) => !DECISIONS.includes(d))) problems.push(`${at}: bad ok ${JSON.stringify(c.ok)}`)
    if (!c.ok?.includes(c.ideal)) problems.push(`${at}: ideal ${c.ideal} not in ok`)
    if (!c.why?.trim()) problems.push(`${at}: missing why`)
    if (c.base && !ids.has(c.base)) problems.push(`${at}: base ${c.base} not in set`)
    if (set.name.startsWith('corpus/')) {
      const s = c.source
      if (!s) problems.push(`${at}: imported case without source`)
      else {
        for (const k of ['name', 'url', 'commit', 'path', 'ref', 'license'] as const) if (!s[k]) problems.push(`${at}: source.${k} missing`)
        if (s.license && !IMPORTABLE_LICENSES.includes(s.license)) problems.push(`${at}: license ${s.license} not importable`)
      }
      if (c.split !== 'dev' && c.split !== 'test') problems.push(`${at}: imported case without split`)
      else if (c.split !== splitFor(c.base ?? c.id)) problems.push(`${at}: split ${c.split} disagrees with splitFor`)
    }
  }
  return problems
}
