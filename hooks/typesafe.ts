// Typed request/response shapes for TypeSafe's System One endpoint.
//
// Mirrors the wire format documented at https://docs.typesafe.ai/api and the
// types in @typesafe-ai/sdk v0.6.0. A mod can only import its own files, so we
// don't depend on the SDK; we build the body here and send it with
// $.http.fetch from register.ts.

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type NoulQuestion = {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}

export type NoulAnswer = {
  type: 'noul'
  /** Probability (0–1) that the statement is true. */
  noul: number
}

export type SystemOneRequest<K extends string> = {
  model: string
  state: JsonValue
  questions: Record<K, NoulQuestion>
}

export type SystemOneResponse<K extends string> = {
  model: string
  answers: Record<K, NoulAnswer>
  usage?: { input_tokens: number; output_tokens: number }
}

/** Pull one `NAME=value` line out of a .env file's text; quotes and `export ` are allowed. */
export function readDotenvValue(text: string, name: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line.startsWith(`${name}=`)) continue
    const value = line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    return value || undefined
  }
  return undefined
}

/** Narrow an untyped response body to the noul answers we asked for. */
export function parseNoulResponse<K extends string>(
  body: unknown,
  keys: readonly K[],
): SystemOneResponse<K> {
  if (typeof body !== 'object' || body === null) throw new Error('TypeSafe response is not an object')
  const { model, answers, usage } = body as Record<string, unknown>
  if (typeof answers !== 'object' || answers === null) throw new Error('TypeSafe response has no answers')
  const out = {} as Record<K, NoulAnswer>
  for (const key of keys) {
    const answer = (answers as Record<string, unknown>)[key] as Partial<NoulAnswer> | undefined
    if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
      throw new Error(`TypeSafe answer "${key}" is missing or not a noul`)
    }
    out[key] = { type: 'noul', noul: answer.noul }
  }
  return {
    model: typeof model === 'string' ? model : 'unknown',
    answers: out,
    usage: usage as SystemOneResponse<K>['usage'],
  }
}
