/**
 * Recognizing an attempt to close a bead through the raw `bd` CLI.
 *
 * ## Why this exists
 *
 * `bd init` writes an `AGENTS.md` block and a beads skill into the workspace,
 * both of which teach agents to drive the CLI directly: `bd ready`, `bd close
 * <id>`. That guidance is correct for Claude Code and Codex, where these tools
 * do not exist — and it is read by an agent running inside dsh, where they do.
 * An agent that follows it runs `bd close` in bash, and every guarantee
 * `bead_close` provides is skipped: the bead's declared verification never
 * runs, no evidence comment is recorded, the actor is whoever the shell says,
 * and nothing is bounded or framed.
 *
 * Editing the workspace's `AGENTS.md` is not an option — it is a shared repo
 * file read by tools this plugin knows nothing about. So the correction is made
 * at runtime instead, and this module is the recognizer behind it.
 *
 * ## This is a guardrail, NOT a security boundary
 *
 * Read this before trusting it for anything. It is a DENYLIST, and a denylist
 * over shell strings is permissive by construction: anything it does not
 * recognize runs. That is the opposite of consult's `report-exec-policy`, whose
 * allowlist denies whatever it does not fully understand — there, ambiguity
 * fails safe; here, ambiguity passes.
 *
 * Every one of these evades it, by design and without cleverness:
 *
 *   $(echo bd) close x        the command name is computed, not written
 *   BD=bd; $BD close x        same, through a variable
 *   ./scripts/wrap.sh         a wrapper script whose contents are not read
 *   python -c "...bd close"   another interpreter's argv
 *   bd  close  x              (handled) but any encoding this does not model
 *
 * It stops an agent that is honestly following the AGENTS.md instructions,
 * which is the entire population it is aimed at. It stops nothing that is
 * trying. Anyone who needs an actual boundary needs the sandbox, not this.
 *
 * The recognizer is also only reached for calls to the configured shell tools;
 * a subagent's own shell, an MCP server, or a hook never passes through the
 * tool pipeline at all. That gap is upstream of this plugin and is tracked as
 * bead `beads-dsr`.
 *
 * @module @aubwang/dsh-beads/cli-guard
 */

/** What a recognized invocation was trying to do. */
export type CloseAttemptKind = 'close' | 'update-closed'

/** One recognized attempt to close a bead through the CLI. */
export interface CloseAttempt {
  kind: CloseAttemptKind
  /** The bead id, when one could be read off the command line. */
  beadId?: string
}

/** Shells whose `-c` argument is unwrapped and re-examined. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** The spellings that mean "the next token is the whole script". */
const SHELL_COMMAND_FLAGS = new Set(['-c', '-lc', '-cl', '-ic'])

/**
 * Leading words that prefix a command without changing which program runs.
 * Stripped so `sudo bd close x` is still recognized as a `bd close`.
 */
const TRANSPARENT_PREFIXES = new Set(['sudo', 'command', 'nohup', 'exec', 'time', 'nice', 'env'])

/** bd global flags that consume the following token, so it is not the subcommand. */
const VALUE_FLAGS = new Set(['-C', '--directory', '--actor', '--db', '--dolt-auto-commit'])

/** Recursion bound for nested `bash -c "bash -c ..."`; deeper than this is obfuscation, not usage. */
const MAX_UNWRAP_DEPTH = 3

/**
 * Find an attempt to close a bead in one shell command.
 *
 * The rule, stated so it can be argued with: a segment counts only when the
 * FIRST word of it — after transparent prefixes and `NAME=value` assignments —
 * names `bd`. That is what keeps `grep "bd close" AGENTS.md` and `echo bd
 * close` allowed: their first word is `grep` and `echo`, so whatever follows is
 * an argument, not an invocation. Splitting is quote-aware for the same reason,
 * so `echo "a && bd close x"` stays one segment led by `echo`.
 * @param command - the shell command a bash-family tool was asked to run.
 * @returns the recognized attempt, or undefined when nothing matched.
 */
export function findBdClose(command: string): CloseAttempt | undefined {
  return scan(command, 0)
}

function scan(command: string, depth: number): CloseAttempt | undefined {
  if (depth > MAX_UNWRAP_DEPTH) return undefined
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment)
    if (tokens.length === 0) continue
    const argv = stripPrefixes(tokens)
    const head = argv[0]
    if (head === undefined) continue
    // A shell wrapper is unwrapped rather than trusted: several tool surfaces
    // route everything through `bash -lc`, so refusing to look inside would
    // make the guard blind in exactly the common case.
    if (SHELLS.has(basename(head))) {
      const script = shellScript(argv)
      if (script !== undefined) {
        const found = scan(script, depth + 1)
        if (found !== undefined) return found
      }
      continue
    }
    if (basename(head) !== 'bd') continue
    const found = inspectBd(argv.slice(1))
    if (found !== undefined) return found
  }
  return undefined
}

/** Read the subcommand and flags of one `bd` invocation. */
function inspectBd(args: readonly string[]): CloseAttempt | undefined {
  let index = 0
  let subcommand: string | undefined
  while (index < args.length) {
    const token = args[index]!
    if (VALUE_FLAGS.has(token)) { index += 2; continue }
    if (token.startsWith('-')) { index += 1; continue }
    subcommand = token
    index += 1
    break
  }
  if (subcommand === 'close') {
    return { kind: 'close', ...beadIdOf(args.slice(index)) }
  }
  if (subcommand !== 'update') return undefined
  // `bd update <id> --status closed` reaches the same end as `bd close` while
  // running none of what closing is supposed to mean — the same bypass the
  // bead_update tool already refuses.
  const rest = args.slice(index)
  const closesIt = rest.some((token, position) =>
    token === '--status=closed'
    || token === '-s=closed'
    || ((token === '--status' || token === '-s') && rest[position + 1] === 'closed'))
  return closesIt ? { kind: 'update-closed', ...beadIdOf(rest) } : undefined
}

/** The first non-flag argument, which is where bd takes the issue id. */
function beadIdOf(args: readonly string[]): { beadId?: string } {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!
    if (token === '--status' || token === '-s' || token === '--reason' || token === '-r') { index += 1; continue }
    if (token.startsWith('-')) continue
    return { beadId: token }
  }
  return {}
}

/** Drop `NAME=value` assignments and prefix words that do not change what runs. */
function stripPrefixes(tokens: readonly string[]): string[] {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue }
    if (TRANSPARENT_PREFIXES.has(basename(token))) { index += 1; continue }
    break
  }
  return tokens.slice(index)
}

/** The script argument of a `sh -c "..."` style invocation. */
function shellScript(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    if (SHELL_COMMAND_FLAGS.has(argv[index]!)) return argv[index + 1]
  }
  return undefined
}

/** Path-qualified names still name the program: `/usr/local/bin/bd` is `bd`. */
function basename(token: string): string {
  const cleaned = token.replace(/^['"]|['"]$/g, '')
  const cut = cleaned.lastIndexOf('/')
  return cut === -1 ? cleaned : cleaned.slice(cut + 1)
}

/**
 * Split a command on shell operators, ignoring any that sit inside quotes.
 *
 * Quote awareness is what stops a false positive on `echo "a && bd close x"`:
 * a naive split would produce a segment whose first word is `bd`.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | undefined
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote !== undefined) {
      if (character === '\\' && quote === '"') { current += character + (command[index + 1] ?? ''); index += 1; continue }
      current += character
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue }
    if (character === '\\') { current += character + (command[index + 1] ?? ''); index += 1; continue }
    const pair = command.slice(index, index + 2)
    if (pair === '&&' || pair === '||') { segments.push(current); current = ''; index += 1; continue }
    if (character === ';' || character === '|' || character === '&' || character === '\n') {
      segments.push(current); current = ''; continue
    }
    current += character
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/** Split one segment into tokens, honoring quotes and stripping them from the result. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: string | undefined
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!
    if (quote !== undefined) {
      if (character === quote) { quote = undefined; continue }
      if (character === '\\' && quote === '"') { current += segment[index + 1] ?? ''; index += 1; continue }
      current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue }
    if (character === '\\') { current += segment[index + 1] ?? ''; index += 1; started = true; continue }
    if (/\s/.test(character)) {
      if (started || current.length > 0) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += character
    started = true
  }
  if (started || current.length > 0) tokens.push(current)
  return tokens
}
