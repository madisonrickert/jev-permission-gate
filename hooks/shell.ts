// A small shell lexer for the blocklist. It doesn't run or expand anything;
// it finds the program each part of a command runs, the way a shell would,
// so quoting, escapes, keywords, wrappers, and nested shells can't hide one.
//
// It errs toward finding more programs, never fewer. Anything it can't parse
// is reported as a problem, and the caller defers the call.

export type Analysis = {
  /** Every program the command would run, lowercased, without its path. */
  programs: string[]
  /** Argument lists per program run, after quote removal, for shape checks (git subcommands, find -exec, …). */
  invocations: string[][]
  /** Targets of output redirections (`> f`, `>> f`, `tee f` is handled by the caller). */
  writes: string[]
  /** Reasons the command can't be judged statically. */
  problems: string[]
}

// Words that start a compound command or negate one; the program follows.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac', 'select', 'function', '!', '{', '}', '[[', ']]', 'coproc'])

// Wrappers that run the next word as a command, with the options that take an argument.
const WRAPPERS: Record<string, readonly string[]> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  time: ['-f', '--format', '-o', '--output'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  caffeinate: ['-t', '-w'],
  stdbuf: ['-i', '-o', '-e'],
  unbuffer: [],
  watch: ['-n', '--interval', '-d'],
  xargs: ['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-s', '-a', '-E', '-e', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace'],
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  doas: ['-u', '-C'],
  ionice: ['-c', '-n', '-p'],
  chrt: [],
  taskset: [],
  flock: ['-w', '-E'],
}

// Runners whose next word is a program they fetch or run (`npx foo`, `uv run foo`).
const RUNNERS: Record<string, readonly string[]> = {
  npx: [], bunx: [], uvx: [], pipx: ['run'], uv: ['run', 'tool'], pnpm: ['dlx', 'exec'], yarn: ['dlx', 'exec'], poetry: ['run'], pdm: ['run'], hatch: ['run'], bundle: ['exec'], dotenv: [],
}

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox'])
export const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript', 'pwsh', 'powershell'])

// Characters a reader can't see, and controls other than tab and newline.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/

type Token = { kind: 'word'; text: string; quoted: boolean } | { kind: 'op'; text: string }

/** Analyze a shell command. `depth` bounds recursion into nested shells. */
export function analyze(command: string, depth = 0): Analysis {
  const out: Analysis = { programs: [], invocations: [], writes: [], problems: [] }
  if (depth > 4) {
    out.problems.push('shell nesting too deep')
    return out
  }
  if (INVISIBLE.test(command)) out.problems.push('invisible or control characters')
  // Fullwidth and other compatibility forms read as their ASCII letters.
  const text = command.normalize('NFKC').replace(/\\\r?\n/g, '')
  let tokens: Token[]
  const nested: string[] = []
  const heredocs: { body: string; segmentIndex: number }[] = []
  try {
    tokens = lex(text, nested, heredocs)
  } catch (e) {
    out.problems.push((e as Error).message)
    return out
  }

  // Split into simple commands at control operators.
  const segments: Token[][] = [[]]
  for (const t of tokens) {
    if (t.kind === 'op' && /^(&&|\|\||;|;;|\||\|&|&|\n|\(|\))$/.test(t.text)) segments.push([])
    else segments.at(-1)!.push(t)
  }

  segments.forEach((segment, index) => {
    const words: string[] = []
    for (let i = 0; i < segment.length; i++) {
      const t = segment[i]!
      if (t.kind === 'op') {
        // A redirection operator takes the next word as its target.
        const target = segment[i + 1]
        if (/^\d*(>|>>|>\||&>|&>>)$/.test(t.text) && target?.kind === 'word') out.writes.push(target.text)
        if (target?.kind === 'word' && /^\d*(<|>|>>|>\||&>|&>>|<>|<<<)$/.test(t.text)) i++
        continue
      }
      words.push(t.text)
    }
    const body = heredocs.find((h) => h.segmentIndex === index)?.body
    walk(words, out, depth, body)
  })

  for (const sub of nested) merge(out, analyze(sub, depth + 1))
  return out
}

function merge(into: Analysis, from: Analysis) {
  into.programs.push(...from.programs)
  into.invocations.push(...from.invocations)
  into.writes.push(...from.writes)
  into.problems.push(...from.problems)
}

/** Find the program in one simple command's words, following keywords, wrappers, runners, and nested shells. */
function walk(words: string[], out: Analysis, depth: number, heredoc?: string) {
  let i = 0
  for (;;) {
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(words[i]!) || KEYWORDS.has(words[i]!))) {
      // `for x in a b c; do` : the words after `for` and `in` are data, not programs.
      if (words[i] === 'for' || words[i] === 'select' || words[i] === 'case') return
      i++
    }
    const word = words[i]
    if (word === undefined) return
    if (word.startsWith('$') || word.includes('$(') || word.includes('`')) {
      out.problems.push('command name comes from a variable or substitution')
      return
    }
    const program = word.replace(/^.*\//, '').toLowerCase()
    const args = words.slice(i + 1)
    out.programs.push(program)
    out.invocations.push([program, ...args])

    if (program === 'alias') out.problems.push('alias definition')
    if (program === 'env' && args.every((a) => /^-|=/.test(a))) {
      // A bare `env` (or one with only assignments) prints the environment.
      out.programs.push('printenv')
      return
    }

    const wrapperOptions = WRAPPERS[program]
    if (wrapperOptions) {
      i++
      i = skipOptions(words, i, wrapperOptions)
      // Positional arguments before the command: a duration, CPU mask, or lock file.
      if ((program === 'timeout' && /^\d/.test(words[i] ?? '')) || program === 'taskset' || program === 'flock') i++
      if (program === 'chrt' && /^\d+$/.test(words[i] ?? '')) i++
      continue
    }

    const runner = RUNNERS[program]
    if (runner) {
      let j = skipOptions(words, i + 1, ['-p', '--package', '--from', '--with', '-c', '--call', '--spec'])
      if (runner.length) {
        if (!runner.includes(words[j] ?? '')) return
        j = skipOptions(words, j + 1, ['--with', '--from', '-p', '--python'])
      }
      if (j < words.length) {
        i = j
        continue
      }
      return
    }

    if (SHELLS.has(program)) {
      const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a))
      if (args.includes('/dev/fd/63')) out.problems.push('shell running a process substitution')
      if (c >= 0 && args[c + 1] !== undefined) merge(out, analyze(args[c + 1]!, depth + 1))
      else if (heredoc !== undefined) merge(out, analyze(heredoc, depth + 1))
      else if (args.length === 0 || args.every((a) => a.startsWith('-'))) out.problems.push('shell reading commands from input')
      return
    }

    if (program === 'find') {
      for (let k = 0; k < args.length; k++) {
        if (/^-(exec|execdir|ok|okdir)$/.test(args[k]!)) {
          const end = args.findIndex((a, n) => n > k && (a === ';' || a === '+' || a === '\\;'))
          walk(args.slice(k + 1, end < 0 ? undefined : end), out, depth)
        }
      }
    }
    return
  }
}

function skipOptions(words: string[], i: number, withArgument: readonly string[]): number {
  while (i < words.length) {
    const w = words[i]!
    if (w === '--') return i + 1
    if (!w.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !/^\d+$/.test(w)) return i
    i += withArgument.includes(w) ? 2 : 1
  }
  return i
}

/**
 * Split a command into words and operators, removing quotes and escapes the
 * way a shell would. Command and process substitutions go to `nested`;
 * heredoc bodies go to `heredocs`, tagged with the simple command they feed.
 */
function lex(text: string, nested: string[], heredocs: { body: string; segmentIndex: number }[]): Token[] {
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  let quoted = false
  let segmentIndex = 0
  const pendingHeredocs: { delimiter: string; strip: boolean }[] = []
  const end = () => {
    if (inWord) tokens.push({ kind: 'word', text: word, quoted })
    word = ''
    inWord = false
    quoted = false
  }
  const op = (t: string) => {
    end()
    tokens.push({ kind: 'op', text: t })
    if (/^(&&|\|\||;|;;|\||\|&|&|\n|\(|\))$/.test(t)) segmentIndex++
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]

    if (ch === '\\') {
      if (i + 1 >= text.length) throw new Error('trailing backslash')
      word += text[i + 1]
      inWord = true
      i += 2
      continue
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1)
      if (close < 0) throw new Error('unbalanced quoting')
      word += text.slice(i + 1, close)
      inWord = quoted = true
      i = close + 1
      continue
    }
    if (ch === '$' && next === "'") {
      let j = i + 2
      let s = ''
      while (j < text.length && text[j] !== "'") {
        if (text[j] === '\\' && j + 1 < text.length) {
          const [decoded, used] = ansiEscape(text, j + 1)
          s += decoded
          j += 1 + used
        } else s += text[j++]
      }
      if (j >= text.length) throw new Error('unbalanced quoting')
      word += s
      inWord = quoted = true
      i = j + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1]!)) {
          word += text[j + 1]
          j += 2
        } else if (text[j] === '$' && text[j + 1] === '(') {
          const close = matchParen(text, j + 1)
          nested.push(text.slice(j + 2, close))
          word += text.slice(j, close + 1)
          j = close + 1
        } else if (text[j] === '`') {
          const close = text.indexOf('`', j + 1)
          if (close < 0) throw new Error('unbalanced backquote')
          nested.push(text.slice(j + 1, close))
          word += text.slice(j, close + 1)
          j = close + 1
        } else word += text[j++]
      }
      if (j >= text.length) throw new Error('unbalanced quoting')
      inWord = quoted = true
      i = j + 1
      continue
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1)
      if (close < 0) throw new Error('unbalanced backquote')
      nested.push(text.slice(i + 1, close))
      word += text.slice(i, close + 1)
      inWord = true
      i = close + 1
      continue
    }
    if ((ch === '$' || ch === '<' || ch === '>') && next === '(' && !(ch === '$' && text[i + 2] === '(')) {
      const close = matchParen(text, i + 1)
      nested.push(text.slice(i + 2, close))
      if (ch === '$') word += text.slice(i, close + 1)
      else word += '/dev/fd/63'
      inWord = true
      i = close + 1
      continue
    }
    if (ch === '$' && next === '(' && text[i + 2] === '(') {
      // Arithmetic expansion: $(( … )).
      const close = text.indexOf('))', i + 3)
      if (close < 0) throw new Error('unbalanced arithmetic')
      word += text.slice(i, close + 2)
      inWord = true
      i = close + 2
      continue
    }
    if (ch === '#' && !inWord) {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '\n') {
      op('\n')
      i++
      // Heredoc bodies start on the line after their operator.
      while (pendingHeredocs.length) {
        const { delimiter, strip } = pendingHeredocs.shift()!
        const lines: string[] = []
        let found = false
        while (i < text.length) {
          const nl = text.indexOf('\n', i)
          const line = text.slice(i, nl < 0 ? undefined : nl)
          i = nl < 0 ? text.length : nl + 1
          if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) {
            found = true
            break
          }
          lines.push(line)
        }
        if (!found) throw new Error('unterminated heredoc')
        heredocs.push({ body: lines.join('\n'), segmentIndex: segmentIndex - 1 })
      }
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      end()
      i++
      continue
    }
    if (ch === '<' && next === '<' && text[i + 2] !== '<') {
      // Heredoc: <<WORD or <<-WORD. Read the delimiter, quotes removed.
      const strip = text[i + 2] === '-'
      end()
      tokens.push({ kind: 'op', text: '<<' })
      let j = i + (strip ? 3 : 2)
      while (text[j] === ' ' || text[j] === '\t') j++
      const m = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(text.slice(j))
      if (!m) throw new Error('unreadable heredoc delimiter')
      pendingHeredocs.push({ delimiter: m[2]!, strip })
      i = j + m[0].length
      continue
    }
    const three = text.slice(i, i + 3)
    const two = text.slice(i, i + 2)
    if (three === '<<<' || three === '&>>' || three === ';;&') {
      op(three)
      i += 3
      continue
    }
    if (['&&', '||', ';;', '|&', '>>', '&>', '>|', '<>', '>&', '<&'].includes(two)) {
      if (two === '>&' || two === '<&') {
        // fd duplication: 2>&1, >&2. The target is a descriptor, not a file.
        const fd = /^\d*-?/.exec(text.slice(i + 2))![0]
        if (inWord && /^\d+$/.test(word)) {
          word = ''
          inWord = false
        }
        end()
        i += 2 + fd.length
        continue
      }
      if (inWord && /^\d+$/.test(word) && (two === '>>' || two === '>|')) {
        const fd = word
        word = ''
        inWord = false
        op(fd + two)
      } else op(two)
      i += 2
      continue
    }
    if ('|&;()<>'.includes(ch)) {
      if ((ch === '>' || ch === '<') && inWord && /^\d+$/.test(word)) {
        const fd = word
        word = ''
        inWord = false
        op(fd + ch)
      } else op(ch)
      i++
      continue
    }
    if ((ch === '{' || ch === '}') && !inWord && (next === undefined || /\s/.test(next) || ch === '}')) {
      // Brace groups: treat `{` and `}` as keywords, which walk() skips.
      end()
      tokens.push({ kind: 'word', text: ch, quoted: false })
      i++
      continue
    }
    word += ch
    inWord = true
    i++
  }
  if (pendingHeredocs.length) throw new Error('unterminated heredoc')
  end()
  return tokens
}

function matchParen(text: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let j = open; j < text.length; j++) {
    const c = text[j]!
    if (quote) {
      if (c === '\\' && quote === '"') j++
      else if (c === quote) quote = null
      continue
    }
    if (c === '\\') j++
    else if (c === "'" || c === '"') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  throw new Error('unbalanced parenthesis')
}

/** Decode one ANSI-C escape starting after the backslash; returns the text and how many characters it used. */
function ansiEscape(text: string, at: number): [string, number] {
  const c = text[at]!
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
  if (simple[c] !== undefined) return [simple[c]!, 1]
  let m: RegExpExecArray | null
  if ((m = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(at)))) return [String.fromCharCode(parseInt(m[1]!, 16)), m[0].length]
  if ((m = /^u([0-9a-fA-F]{1,4})/.exec(text.slice(at)))) return [String.fromCharCode(parseInt(m[1]!, 16)), m[0].length]
  if ((m = /^U([0-9a-fA-F]{1,8})/.exec(text.slice(at)))) return [String.fromCodePoint(parseInt(m[1]!, 16)), m[0].length]
  if ((m = /^([0-7]{1,3})/.exec(text.slice(at)))) return [String.fromCharCode(parseInt(m[1]!, 8)), m[0].length]
  if ((m = /^c(.)/.exec(text.slice(at)))) return [String.fromCharCode(m[1]!.charCodeAt(0) & 31), 2]
  return ['\\' + c, 1]
}
