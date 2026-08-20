/**
 * The `bd` (beads) CLI adapter, expressed as dependency-injected functions over
 * one `spawn` callable rather than as methods on a class. Everything here is
 * testable without a Cordis context: the environment template, argv
 * construction, the two JSON parse modes, the exit-code and stderr mapping onto
 * typed outcomes, and the per-workspace write queue.
 *
 * The CLI is the whole contract. Nothing here reads `.beads/` directly, opens
 * the embedded Dolt database, or shells out to `dolt`; the only state this
 * module knows about is what a `--json` invocation hands back.
 *
 * ## What was verified against the installed binary
 *
 * Every claim below was probed against `bd` 1.2.2 (build 6c124203e), not read
 * out of the source tree — which is AHEAD of the release and describes flags
 * 1.2.2 does not have.
 *
 * - `BD_JSON_ENVELOPE=1` IS honored: stdout becomes `{data, schema_version}`,
 *   where `data` is the bare payload (an object for `create`/`dep add`, an
 *   array for `list`/`ready`/`show`/`search`/`update`/`close`). Without it the
 *   same payloads arrive bare, with `schema_version` merged into object
 *   payloads and absent from array ones. {@link parseBdJson} accepts both, so
 *   a `bd` that stops honoring the variable degrades instead of breaking.
 * - Error paths are NOT reliably JSON. `bd show <missing>` writes an envelope
 *   carrying `{error}` to stdout AND a plain sentence to stderr; `bd update
 *   --claim` on a taken bead writes nothing to stdout and a plain sentence to
 *   stderr. stderr text is therefore the authority for classification.
 * - There is no exit code 2. 1.2.2 reports unknown flags, unknown commands,
 *   missing arguments, claim conflicts, missing beads, and close refusals all
 *   with exit 1, so the exit code alone carries almost no information and the
 *   stderr text does the work. {@link classifyFailure} is where that happens.
 *
 * @module @aubwang/dsh-beads/bd-cli
 */

import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { boundText, firstLines } from './bounds.ts'

/** The one process primitive this adapter needs; `ctx.subprocess.spawn` satisfies it. */
export type BdSpawn = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** Everything one `bd` invocation needs beyond its arguments. */
export interface BdInvocation {
  /** Executable plus any fixed leading arguments (e.g. `['bd']`, or `['node', '/path/bd.js']`). */
  command: readonly string[]
  /** Workspace the ledger lives in; passed as `bd -C <root>` AND as the spawn cwd. */
  workspaceRoot: string
  /** Value for `BEADS_ACTOR`. Asserted provenance, never authenticated — see the README. */
  actor: string
  /** Per-stream in-memory cap; overflow keeps the tail. */
  maxOutputBytes: number
  /** SIGTERM→SIGKILL grace, also the drain window for collected pipes. */
  graceMs: number
  signal?: AbortSignal | undefined
}

/** One completed `bd` invocation. */
export interface BdRun {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when either stream lost bytes to its in-memory cap. */
  truncated: boolean
}

/**
 * Environment every invocation carries.
 *
 * All of it is about making `bd` behave like a library call rather than like a
 * terminal program: no prompts, no pager, no colour, no metrics beacon, no
 * background Dolt server started behind our back. `BEADS_ACTOR` is layered by
 * {@link buildBdEnv} because it is per-call.
 *
 * `BD_NON_INTERACTIVE=1` also disables `bd`'s last-touched-bead fallback, which
 * would otherwise let an id-less command act on whatever bead was most recently
 * mentioned. This plugin never relies on that fallback — every command names
 * its ids explicitly — but turning it off means a bug in this plugin fails
 * loudly instead of quietly editing the wrong bead.
 */
export const BD_BASE_ENV: Readonly<Record<string, string>> = Object.freeze({
  BD_NON_INTERACTIVE: '1',
  CI: '1',
  NO_COLOR: '1',
  BD_NO_PAGER: '1',
  BD_DISABLE_METRICS: '1',
  BD_DISABLE_EVENT_FLUSH: '1',
  BEADS_DOLT_AUTO_START: '0',
  BD_JSON_ENVELOPE: '1',
})

/** `bd` versions this plugin will talk to: `>=1.2.0 <2.0.0`. */
export const SUPPORTED_BD_RANGE = { major: 1, minMinor: 2 } as const

/**
 * Build the explicit environment for one invocation.
 * @param actor - the `BEADS_ACTOR` value for this call.
 * @param passthrough - deployment-configured entries layered FIRST, so managed keys always win.
 * @returns the explicit env map for {@link SubprocessSpawnSpec.env}.
 */
export function buildBdEnv(actor: string, passthrough?: Readonly<Record<string, string>>): Record<string, string> {
  return { ...passthrough, ...BD_BASE_ENV, BEADS_ACTOR: actor }
}

/**
 * Spawn one `bd` invocation and collect its bounded output.
 *
 * stdin is `'ignore'`, not `'inherit'`: `bd` decides interactivity partly from
 * whether stdin is a terminal, and a plugin that let a subprocess inherit the
 * harness's stdin could hand a prompt to a model that cannot answer it.
 * @param spawn - the subprocess seam's spawn callable.
 * @param args - arguments after {@link BdInvocation.command} and the `-C` pair.
 * @param invocation - executable, workspace, actor, and budgets.
 * @returns exit facts plus both collected streams.
 */
export async function runBd(
  spawn: BdSpawn,
  args: readonly string[],
  invocation: BdInvocation,
  options: { inWorkspace?: boolean } = {},
): Promise<BdRun> {
  // `-C` is checked before the subcommand runs, so `bd -C <uninitialized> version`
  // fails with "no beads project found" — the workspace error, not the version
  // one. Preflight therefore gates the BINARY without `-C` and the WORKSPACE
  // with it, which is what lets a wrong `bd` and a missing ledger produce
  // different, individually actionable outcomes.
  const prefix = options.inWorkspace === false ? [] : ['-C', invocation.workspaceRoot]
  const handle = spawn({
    argv: [...invocation.command, ...prefix, ...args],
    cwd: invocation.workspaceRoot,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: invocation.maxOutputBytes },
      stderr: { maxBytes: invocation.maxOutputBytes },
    },
    graceMs: invocation.graceMs,
    ...invocation.signal !== undefined ? { signal: invocation.signal } : {},
    env: buildBdEnv(invocation.actor),
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    truncated: (stdout?.lossy ?? false) || (stderr?.lossy ?? false),
  }
}

/**
 * Serialized, retrying invocation.
 *
 * TWO separate mechanisms, for two separate hazards:
 *
 * 1. The QUEUE. All invocations for one workspace run one at a time, keyed by
 *    the resolved workspace root, so two tool calls in one harness cannot
 *    stampede the same embedded database. The key is the workspace rather than
 *    the plugin instance because two plugin instances pointing at one ledger
 *    are the same hazard as one instance called twice.
 * 2. The RETRY. Probing found that bd 1.2.2 does NOT fail under concurrency —
 *    twenty simultaneous `bd create` processes against one workspace all
 *    succeeded, taking about the wall time of twenty sequential ones, so the
 *    embedded engine blocks on the lock rather than erroring. The retry
 *    therefore exists for the case that DOES error and that no amount of
 *    in-process queueing can prevent: a bd process outside this harness (a
 *    human's terminal, an inherit-mode delegate, a crashed run that left a
 *    stale lock) holding the database. It fires only on bd's own lock
 *    vocabulary, which is copied from its `isLockError` classifier.
 *
 * @param spawn - the subprocess seam's spawn callable.
 * @param args - arguments after the command prefix and `-C` pair.
 * @param invocation - executable, workspace, actor, and budgets.
 * @param retryMs - backoff before the single retry; `0` disables retrying.
 * @returns the last run performed.
 */
export async function runBdSerialized(
  spawn: BdSpawn,
  args: readonly string[],
  invocation: BdInvocation,
  retryMs: number,
): Promise<BdRun> {
  return enqueue(invocation.workspaceRoot, async () => {
    const first = await runBd(spawn, args, invocation)
    if (first.exitCode === 0 || retryMs <= 0) return first
    if (!isLockContention(first.stderr) && !isLockContention(first.stdout)) return first
    const aborted = (): boolean => invocation.signal?.aborted ?? false
    if (aborted()) return first
    await sleep(retryMs, invocation.signal)
    if (aborted()) return first
    return runBd(spawn, args, invocation)
  })
}

/**
 * `bd`'s own lock-error vocabulary, transcribed from `isLockError` in
 * `internal/storage/dolt/store.go` plus the sentence `wrapLockError` prepends.
 * Matching bd's classifier rather than inventing one means this plugin retries
 * exactly the situations bd itself calls lock contention.
 */
const LOCK_PHRASES = [
  'database is locked',
  'lock file',
  'noms lock',
  'locked by another dolt process',
  'the dolt database is locked',
] as const

/**
 * Whether a diagnostic describes embedded-Dolt lock contention.
 * @param stderr - the invocation's stderr.
 * @returns true when the text carries bd's lock vocabulary.
 */
export function isLockContention(stderr: string): boolean {
  const text = stderr.toLowerCase()
  return LOCK_PHRASES.some((phrase) => text.includes(phrase))
}

/** One workspace's in-flight chain. Cleared once the chain drains. */
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  // `.then(task, task)` rather than `.finally`: a rejected predecessor must not
  // poison the chain, and the queue is about ordering, not about outcomes.
  const run = previous.then(task, task)
  const tail = run.then(() => undefined, () => undefined)
  queues.set(key, tail)
  // Only the CURRENT tail clears the entry, so a call that already chained onto
  // this promise is never stranded behind a deleted one.
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** Which JSON framing an invocation's stdout turned out to use. */
export type BdParseMode = 'envelope' | 'legacy'

/** One decoded `bd --json` payload. */
export interface BdPayload {
  /** The bare payload: an object for single-record commands, an array for collections. */
  data: unknown
  /** Which framing the output used. Recorded so the README's claim stays checkable. */
  mode: BdParseMode
  /** `schema_version`, when the output carried one. */
  schemaVersion?: number
}

/**
 * Decode one `bd --json` stdout in whichever framing it arrived in.
 *
 * Envelope framing (`BD_JSON_ENVELOPE=1`, which 1.2.2 honors) is
 * `{data, schema_version}`. Legacy framing is the payload itself, with
 * `schema_version` merged in for object payloads and absent for arrays.
 * Distinguishing them is unambiguous: only the envelope has a `data` key
 * alongside `schema_version`, and no bead record has a field called `data`.
 * @param stdout - the invocation's stdout.
 * @returns the decoded payload.
 * @throws Error when stdout is empty or not JSON — an infrastructure failure, not a domain outcome.
 */
export function parseBdJson(stdout: string): BdPayload {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) throw new Error('bd produced no JSON output')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`bd --json output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (Array.isArray(parsed)) return { data: parsed, mode: 'legacy' }
  if (!isRecord(parsed)) return { data: parsed, mode: 'legacy' }
  const schemaVersion = typeof parsed.schema_version === 'number' ? parsed.schema_version : undefined
  if ('data' in parsed) {
    return { data: parsed.data, mode: 'envelope', ...schemaVersion !== undefined ? { schemaVersion } : {} }
  }
  return { data: parsed, mode: 'legacy', ...schemaVersion !== undefined ? { schemaVersion } : {} }
}

/**
 * Decode a payload that must be a list of records.
 *
 * `bd show`, `bd update`, and `bd close` return arrays even for a single id, so
 * a caller that asked about one bead still reads element zero rather than
 * special-casing. A single object is accepted and wrapped, because the legacy
 * framing of some commands is a bare object.
 * @param payload - a decoded payload.
 * @returns the records, in emission order.
 */
export function asRecords(payload: BdPayload): Record<string, unknown>[] {
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord)
  if (isRecord(payload.data)) return [payload.data]
  return []
}

/** The domain outcome families this plugin distinguishes. Everything else is an infrastructure failure. */
export type BdFailureCode =
  | 'not-initialized'
  | 'bd-unusable'
  | 'not-found'
  | 'claim-conflict'
  | 'close-refused'
  | 'workspace-busy'
  | 'use-bead-close'
  | 'verification-unavailable'
  | 'rejected'

/** One classified `bd` failure. */
export interface BdFailure {
  code: BdFailureCode
  /** Bounded, model-facing headline. */
  message: string
  /** Bounded diagnostic text from `bd` itself. Untrusted: it can quote bead prose. */
  detail: string
  /** The actor named by a claim conflict, when bd named one. */
  holder?: string
}

/**
 * A failure this plugin caused, rather than one the model can act on.
 *
 * Every argv here is plugin-authored, so an unknown flag, an unknown
 * subcommand, or a missing required argument means this code is wrong. Those
 * throw and surface as `isError` tool failures instead of being dressed up as
 * something the model did.
 */
export class BdInvocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BdInvocationError'
  }
}

/**
 * Patterns that mean this plugin built a bad command line.
 *
 * Deliberately narrow. `invalid argument` is matched only in cobra's own
 * `invalid argument "x" for "--flag"` form, because bd uses the bare words in
 * ordinary validation messages a MODEL can cause — `invalid priority "99"`,
 * `invalid issue type: nonsense` — and turning one of those into a thrown
 * infrastructure error would tell the model its harness is broken when in fact
 * it passed a number out of range.
 */
const PLUGIN_BUG_PATTERNS = [
  /unknown flag/i,
  /unknown command/i,
  /unknown shorthand flag/i,
  /invalid argument "[^"]*" for/i,
  /accepts \d+ arg/i,
  /flag needs an argument/i,
] as const

/**
 * Map one failed invocation onto a typed domain outcome.
 *
 * The exit code is nearly useless here — 1.2.2 answers almost everything with
 * exit 1 — so classification reads bd's stderr sentence. Each pattern below was
 * copied from output this plugin's author actually provoked; the ones that
 * could not be provoked (lock contention) are transcribed from bd's own
 * classifier and are exercised by a fake spawn in the tests rather than
 * pretended to be observed.
 * @param run - the completed invocation.
 * @param what - a short description of the attempted operation, used in messages.
 * @param maxDetailBytes - byte budget for the quoted diagnostic.
 * @returns the classified outcome.
 * @throws BdInvocationError when the diagnostic says this plugin built a bad command.
 */
export function classifyFailure(run: BdRun, what: string, maxDetailBytes: number): BdFailure {
  // Three places a diagnostic can hide, in decreasing order of usefulness:
  // stderr (the common case), a structured `{data:{error}}` payload on stdout
  // (how `bd dep add` reports a conflicting edge, with stderr EMPTY), and raw
  // stdout. Reading the structured one is what keeps a JSON blob out of the
  // model's face for the commands that use it.
  const raw = run.stderr.trim().length > 0
    ? run.stderr
    : extractJsonError(run.stdout) ?? run.stdout
  const detail = firstLines(raw, 20, maxDetailBytes)
  if (run.exitCode === null) {
    throw new BdInvocationError(`bd was killed by signal ${run.signal ?? 'unknown'} while ${what}`)
  }
  if (PLUGIN_BUG_PATTERNS.some((pattern) => pattern.test(detail))) {
    throw new BdInvocationError(`bd rejected a command this plugin built while ${what} (exit ${run.exitCode}): ${detail}`)
  }
  if (isLockContention(detail)) {
    return {
      code: 'workspace-busy',
      message: `the beads workspace is locked by another bd process, so ${what} did not happen`,
      detail,
    }
  }
  // bd 1.2.2 has TWO sentences for this one situation, and which one you get
  // depends on how the workspace was selected: `-C <dir>` (what this plugin
  // always does) reports `cannot use -C directory "<dir>": no beads project
  // found`, while resolving from the process cwd reports `no beads database
  // found` with a `bd init` hint. Both are matched, because a plugin that only
  // knew about its own code path would misclassify the other as a generic
  // refusal the moment anything changed how the workspace is chosen. The `-C`
  // phrase also covers a directory that does not exist at all — same
  // remediation, and equally not something a model can fix by rephrasing.
  if (/no beads project found|no beads database found|cannot use -C directory|not a beads (workspace|repository)|bd init/i.test(detail)) {
    return {
      code: 'not-initialized',
      message: 'this workspace has no beads ledger, so there is nothing to read or write',
      detail,
    }
  }
  const claimed = /already claimed by ([^\n]+?)\s*$/im.exec(detail)
  if (claimed !== null) {
    const holder = claimed[1]?.trim() ?? ''
    return {
      code: 'claim-conflict',
      message: `that bead is already claimed by ${holder.length > 0 ? holder : 'another actor'}`,
      detail,
      ...holder.length > 0 ? { holder } : {},
    }
  }
  if (/no issues? found matching|does not exist/i.test(detail)) {
    return { code: 'not-found', message: `no such bead, so ${what} did not happen`, detail }
  }
  if (/open child issue|unsatisfied gate|cannot close/i.test(detail)) {
    return { code: 'close-refused', message: `bd refused the close: ${what} is not permitted yet`, detail }
  }
  return { code: 'rejected', message: `bd refused ${what}`, detail }
}

/**
 * Pull the `error` string out of a JSON payload, in either framing.
 *
 * Some bd commands report a refusal only in their JSON body — `bd dep add` on a
 * conflicting edge exits 1, writes `{"data":{"error":"..."}}` to stdout, and
 * writes NOTHING to stderr — so a classifier that reads stderr first would show
 * the model a raw envelope.
 * @param stdout - the invocation's stdout.
 * @returns the error sentence, or undefined when the output carries none.
 */
export function extractJsonError(stdout: string): string | undefined {
  let payload: BdPayload
  try {
    payload = parseBdJson(stdout)
  } catch {
    return undefined
  }
  const record = isRecord(payload.data) ? payload.data : undefined
  return stringOf(record?.error)
}

/** A bead record projected onto the fields this plugin shows a model. */
export interface Bead {
  id: string
  title: string
  status: string
  priority?: number
  type?: string
  assignee?: string
  createdBy?: string
  createdAt?: string
  updatedAt?: string
  closedAt?: string
  closeReason?: string
  description?: string
  design?: string
  acceptance?: string
  notes?: string
  labels?: string[]
  parent?: string
  /** Verification commands read from `metadata.verify`. */
  verify?: string[]
  /** Hydrated dependencies, present on `bd show` output. */
  dependencies?: BeadEdge[]
  dependencyCount?: number
  dependentCount?: number
  /** True when any prose field lost bytes to its budget. */
  truncated?: boolean
}

/** One hydrated dependency edge, as `bd show` returns it. */
export interface BeadEdge {
  id: string
  title: string
  status: string
  /** The edge type bd recorded (`blocks`, `discovered-from`, …). */
  type?: string
}

/** Per-field byte budgets applied when projecting a record. */
export interface BeadBudgets {
  /** Cap for each individual prose field (description, design, acceptance, notes). */
  proseBytes: number
  /** Maximum hydrated dependencies retained. */
  maxEdges: number
}

/**
 * Project one raw `bd` record onto {@link Bead}, bounding every prose field.
 *
 * Bounding happens HERE rather than at render time because the canonical tool
 * value is what Code Mode reads, and a value that carries an unbounded note is
 * unbounded no matter how carefully the Native renderer trims it.
 * @param raw - one record from a decoded payload.
 * @param budgets - per-field byte budgets.
 * @returns the projected bead, or undefined when the record carries no id.
 */
export function projectBead(raw: Record<string, unknown>, budgets: BeadBudgets): Bead | undefined {
  const id = stringOf(raw.id)
  if (id === undefined) return undefined
  let truncated = false
  const prose = (value: unknown): string | undefined => {
    const text = stringOf(value)
    if (text === undefined) return undefined
    const bounded = boundText(text, budgets.proseBytes, 'head')
    truncated ||= bounded.truncated
    return bounded.text
  }
  const title = boundText(stringOf(raw.title) ?? '(untitled)', budgets.proseBytes, 'head')
  truncated ||= title.truncated
  const bead: Bead = {
    id,
    title: title.text,
    status: stringOf(raw.status) ?? 'unknown',
  }
  const priority = typeof raw.priority === 'number' ? raw.priority : undefined
  if (priority !== undefined) bead.priority = priority
  const assign = (key: keyof Bead, value: string | undefined): void => {
    if (value !== undefined) Object.assign(bead, { [key]: value })
  }
  assign('type', stringOf(raw.issue_type))
  assign('assignee', stringOf(raw.assignee))
  assign('createdBy', stringOf(raw.created_by))
  assign('createdAt', stringOf(raw.created_at))
  assign('updatedAt', stringOf(raw.updated_at))
  assign('closedAt', stringOf(raw.closed_at))
  assign('closeReason', prose(raw.close_reason))
  assign('description', prose(raw.description))
  assign('design', prose(raw.design))
  assign('acceptance', prose(raw.acceptance_criteria))
  assign('notes', prose(raw.notes))
  assign('parent', stringOf(raw.parent_id) ?? stringOf(raw.parent))
  const labels = Array.isArray(raw.labels) ? raw.labels.filter((entry): entry is string => typeof entry === 'string') : undefined
  if (labels !== undefined && labels.length > 0) bead.labels = labels
  const verify = readVerify(raw.metadata)
  if (verify !== undefined) bead.verify = verify
  const edges = projectEdges(raw.dependencies, budgets)
  if (edges !== undefined) {
    bead.dependencies = edges.edges
    truncated ||= edges.truncated
  }
  if (typeof raw.dependency_count === 'number') bead.dependencyCount = raw.dependency_count
  if (typeof raw.dependent_count === 'number') bead.dependentCount = raw.dependent_count
  if (truncated) bead.truncated = true
  return bead
}

/**
 * Read `metadata.verify` as a list of shell commands.
 *
 * A non-array, or an array with a non-string in it, is treated as absent rather
 * than partially honored: "run these three commands, one of which I could not
 * read" is not a requirement anyone can act on, and silently dropping the
 * unreadable one would let a malformed bead close on weaker evidence than it
 * declares.
 * @param metadata - the record's `metadata` field.
 * @returns the commands, or undefined when there is no usable list.
 */
export function readVerify(metadata: unknown): string[] | undefined {
  if (!isRecord(metadata)) return undefined
  const verify = metadata.verify
  if (!Array.isArray(verify) || verify.length === 0) return undefined
  if (!verify.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) return undefined
  return verify as string[]
}

function projectEdges(raw: unknown, budgets: BeadBudgets): { edges: BeadEdge[]; truncated: boolean } | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const kept = raw.slice(0, budgets.maxEdges).filter(isRecord)
  const edges: BeadEdge[] = []
  for (const entry of kept) {
    const id = stringOf(entry.id)
    if (id === undefined) continue
    const type = stringOf(entry.dependency_type)
    edges.push({
      id,
      // An edge is a pointer, not a payload: a one-line title is enough to
      // decide whether to go read the bead, and hydrating full descriptions
      // here is how a packet silently becomes a context bomb.
      title: boundText(stringOf(entry.title) ?? '(untitled)', 200, 'head').text,
      status: stringOf(entry.status) ?? 'unknown',
      ...type !== undefined ? { type } : {},
    })
  }
  if (edges.length === 0) return undefined
  return { edges, truncated: raw.length > edges.length }
}

/** The four dependency types this plugin exposes. bd accepts more; these are the ones with settled meaning. */
export const DEP_TYPES = ['blocks', 'discovered-from', 'related', 'parent-child'] as const

/** One of {@link DEP_TYPES}. */
export type DepType = (typeof DEP_TYPES)[number]

/** Statuses `bd update --status` accepts. */
export const BEAD_STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'] as const

/**
 * Statuses `bead_update` will set.
 *
 * `closed` is absent on purpose. `bd update --status closed` closes a bead
 * exactly as `bd close` does, but it runs NONE of what closing is supposed to
 * mean here: the bead's own `metadata.verify` commands never execute, bd's
 * open-children and open-blocker gates are skipped, and no close reason is
 * recorded. Leaving it in the update surface would have made every guarantee
 * `bead_close` offers optional, reachable by a model that simply picked the
 * other tool.
 */
export const UPDATABLE_STATUSES = ['open', 'in_progress', 'blocked', 'deferred'] as const

/** Issue types `bd create --type` accepts without custom-type configuration. */
export const BEAD_TYPES = ['task', 'bug', 'feature', 'epic', 'chore', 'decision'] as const

/** What `bead_create` was asked to create. */
export interface CreateSpec {
  title: string
  type?: string
  priority?: number
  description?: string
  acceptance?: string
  design?: string
  notes?: string
  labels?: string[]
  parent?: string
  /** Typed edges, in bd's `type:id` form. See {@link depArgs} for the direction trap. */
  deps?: { type: DepType; id: string }[]
  verify?: string[]
}

/**
 * Build `bd create` arguments.
 *
 * The title goes through `--title` rather than as a positional argument so a
 * title beginning with a dash cannot be re-read as a flag. Every other
 * model-authored string is a flag VALUE, which cobra never re-parses.
 * @param spec - the requested bead.
 * @returns the argument vector after `bd -C <root>`.
 */
export function createArgs(spec: CreateSpec): string[] {
  const args = ['create', '--title', spec.title, '--json']
  if (spec.type !== undefined) args.push('--type', spec.type)
  if (spec.priority !== undefined) args.push('--priority', String(spec.priority))
  if (spec.description !== undefined) args.push('--description', spec.description)
  if (spec.acceptance !== undefined) args.push('--acceptance', spec.acceptance)
  if (spec.design !== undefined) args.push('--design', spec.design)
  if (spec.notes !== undefined) args.push('--notes', spec.notes)
  if (spec.labels !== undefined && spec.labels.length > 0) args.push('--labels', spec.labels.join(','))
  if (spec.parent !== undefined) args.push('--parent', spec.parent)
  if (spec.deps !== undefined && spec.deps.length > 0) {
    args.push('--deps', spec.deps.map((dep) => `${dep.type}:${dep.id}`).join(','))
  }
  if (spec.verify !== undefined && spec.verify.length > 0) {
    args.push('--metadata', JSON.stringify({ verify: spec.verify }))
  }
  return args
}

/** Filters `bead_ready` can apply. */
export interface ReadySpec {
  limit: number
  unassignedOnly?: boolean
  priority?: number
  label?: string
  /** Atomically claim the first match instead of only listing. */
  claim?: boolean
}

/** Build `bd ready` arguments. */
export function readyArgs(spec: ReadySpec): string[] {
  const args = ['ready', '--json', '-n', String(spec.limit)]
  if (spec.unassignedOnly === true) args.push('--unassigned')
  if (spec.priority !== undefined) args.push('--priority', String(spec.priority))
  if (spec.label !== undefined) args.push('--label', spec.label)
  if (spec.claim === true) args.push('--claim')
  return args
}

/** Filters `bead_list` can apply. */
export interface ListSpec {
  limit: number
  status?: string
  type?: string
  label?: string
  assignee?: string
  /** Free text; routes the call to `bd search` instead of `bd list`. */
  text?: string
}

/**
 * Build `bd list` or `bd search` arguments.
 *
 * Text search is a different subcommand in bd, not a flag, so the tool exposes
 * one surface and this function picks. `search` takes its query through
 * `--query`, again so a leading dash cannot become a flag.
 * @param spec - the requested filters.
 * @returns the argument vector after `bd -C <root>`.
 */
export function listArgs(spec: ListSpec): string[] {
  const args = spec.text === undefined ? ['list'] : ['search', '--query', spec.text]
  args.push('--json', '-n', String(spec.limit))
  if (spec.status !== undefined) args.push('--status', spec.status)
  // `bd search` has no --type filter in 1.2.2; `bd list` does.
  if (spec.type !== undefined && spec.text === undefined) args.push('--type', spec.type)
  if (spec.label !== undefined) args.push('--label', spec.label)
  if (spec.assignee !== undefined) args.push('--assignee', spec.assignee)
  return args
}

/**
 * Build `bd show` arguments.
 *
 * Ids go through repeated `--id` flags rather than positionally: bd added the
 * flag precisely because some real bead ids (`gt--xyz`) look like flags, and a
 * plugin that passes model-supplied ids positionally inherits that ambiguity.
 * @param ids - the beads to read.
 * @param includeComments - stream full comment bodies (slow on busy beads).
 * @returns the argument vector after `bd -C <root>`.
 */
export function showArgs(ids: readonly string[], includeComments: boolean): string[] {
  const args = ['show', '--json']
  for (const id of ids) args.push('--id', id)
  if (includeComments) args.push('--include-comments')
  return args
}

/** What `bead_update` was asked to change. */
export interface UpdateSpec {
  id: string
  status?: string
  priority?: number
  title?: string
  description?: string
  acceptance?: string
  design?: string
  appendNote?: string
  addLabels?: string[]
  removeLabels?: string[]
  assignee?: string
  /** Replaces `metadata.verify` wholesale. An empty array clears it. */
  verify?: string[]
  /** Atomically claim (assign to the actor and move to in_progress). */
  claim?: boolean
}

/** Build `bd update` arguments. */
export function updateArgs(spec: UpdateSpec): string[] {
  const args = ['update', spec.id, '--json']
  if (spec.claim === true) args.push('--claim')
  if (spec.status !== undefined) args.push('--status', spec.status)
  if (spec.priority !== undefined) args.push('--priority', String(spec.priority))
  if (spec.title !== undefined) args.push('--title', spec.title)
  if (spec.description !== undefined) args.push('--description', spec.description)
  if (spec.acceptance !== undefined) args.push('--acceptance', spec.acceptance)
  if (spec.design !== undefined) args.push('--design', spec.design)
  if (spec.appendNote !== undefined) args.push('--append-notes', spec.appendNote)
  for (const label of spec.addLabels ?? []) args.push('--add-label', label)
  for (const label of spec.removeLabels ?? []) args.push('--remove-label', label)
  if (spec.assignee !== undefined) args.push('--assignee', spec.assignee)
  if (spec.verify !== undefined) {
    // `--metadata` MERGES rather than replacing: writing `{"verify": [...]}`
    // onto a bead that also carries `{"team": "platform"}` leaves the team key
    // intact. Verified against 1.2.2 and pinned by a contract test, because the
    // opposite behaviour would make this parameter quietly destructive and the
    // flag's name does not say which it is.
    args.push('--metadata', JSON.stringify({ verify: spec.verify }))
  }
  return args
}

/** Build `bd close` arguments. `--force` is deliberately never passed. */
export function closeArgs(id: string, reason: string): string[] {
  return ['close', id, '--reason', reason, '--json']
}

/**
 * Build `bd comment` arguments.
 *
 * Comments, not notes, for anything this plugin records as EVIDENCE. A note is
 * one mutable prose field that every writer appends to and any writer can
 * replace wholesale; a comment is an append-only record carrying its own
 * author and timestamp, which is what a claim like "these commands passed"
 * needs in order to still mean something a month later. Notes stay the channel
 * for reasoning a human or agent wrote on purpose.
 *
 * bd takes the text positionally, and there is no flag form. A comment
 * beginning with a dash would therefore be re-read as a flag, so the caller is
 * responsible for the leading character — every comment this plugin writes
 * begins with a letter.
 */
export function commentArgs(id: string, text: string): string[] {
  return ['comment', id, text, '--json']
}

/**
 * Build `bd dep add`/`bd dep remove` arguments.
 *
 * DIRECTION, because it is the easiest thing to get backwards: `bd dep add A B`
 * records "A depends on B", i.e. B blocks A. This function keeps bd's own
 * argument order and names its parameters after it, so the tool layer has to
 * be explicit about which bead is which rather than inventing a friendlier
 * order that would silently invert half the graphs anyone builds.
 * @param action - add or remove the edge.
 * @param dependent - the bead that depends on the other (bd's first argument).
 * @param dependency - the bead depended upon (bd's second argument).
 * @param type - the edge type; ignored by `remove`, which matches on the pair.
 * @returns the argument vector after `bd -C <root>`.
 */
export function depArgs(action: 'add' | 'remove', dependent: string, dependency: string, type?: DepType): string[] {
  const args = ['dep', action, dependent, dependency, '--json']
  if (action === 'add' && type !== undefined) args.push('--type', type)
  return args
}

/** Outcome of the `bd version` gate. */
export type VersionGate =
  | { ok: true; version: string }
  | { ok: false; version?: string; reason: string }

/**
 * Gate the installed `bd` at `>=1.2.0 <2.0.0`.
 *
 * The floor is 1.2 because that is where the `--json` shapes this plugin
 * projects were verified; the ceiling is the next major because beads has
 * changed its JSON before and a silent mis-parse of a bead ledger is worse than
 * a loud refusal to start.
 * @param payload - decoded `bd version --json` output.
 * @returns the accepted version, or an actionable refusal.
 */
export function gateBdVersion(payload: BdPayload): VersionGate {
  const record = isRecord(payload.data) ? payload.data : undefined
  const version = stringOf(record?.version)
  if (version === undefined) {
    return { ok: false, reason: 'could not read a version from `bd version --json`' }
  }
  const match = /^(\d+)\.(\d+)\./.exec(version)
  const major = Number(match?.[1])
  const minor = Number(match?.[2])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return { ok: false, version, reason: `could not parse the version \`bd\` reported: ${JSON.stringify(version)}` }
  }
  if (major !== SUPPORTED_BD_RANGE.major || minor < SUPPORTED_BD_RANGE.minMinor) {
    return {
      ok: false,
      version,
      reason: `bd ${version} is outside the supported range >=1.2.0 <2.0.0. `
        + 'Point `bdPath` at a supported install, or upgrade the bd on PATH.',
    }
  }
  return { ok: true, version }
}

/** What `bd context --json` says about the workspace this plugin is pointed at. */
export interface WorkspaceContext {
  repoRoot?: string
  beadsDir?: string
  backend?: string
  isWorktree: boolean
  /** The issue-id prefix new beads get, which is also the database name. */
  database?: string
}

/**
 * Project `bd context --json`.
 * @param payload - the decoded payload.
 * @returns the workspace facts this plugin reports.
 */
export function projectContext(payload: BdPayload): WorkspaceContext {
  const record = isRecord(payload.data) ? payload.data : {}
  const repoRoot = stringOf(record.repo_root)
  const beadsDir = stringOf(record.beads_dir)
  const backend = stringOf(record.backend)
  const database = stringOf(record.database)
  return {
    ...repoRoot !== undefined ? { repoRoot } : {},
    ...beadsDir !== undefined ? { beadsDir } : {},
    ...backend !== undefined ? { backend } : {},
    ...database !== undefined ? { database } : {},
    isWorktree: record.is_worktree === true,
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
