/**
 * Test helpers: a real `bd` workspace on disk, and a real Cordis composition
 * with the real tool registry, the real subprocess seam, and the real shell
 * executor mounted over it.
 *
 * There is no fake `bd` here, and that is deliberate. `bd` is a local,
 * auth-free, sub-second binary; a fake would encode this author's beliefs about
 * its JSON rather than its actual JSON, and the entire risk this plugin carries
 * is that those two differ. The one place a fake appears is
 * `bd-cli.test.ts`'s lock-contention case, where the error could not be
 * provoked for real — and it is a fake SPAWN, not a fake bd, so it exercises
 * only the classifier and retry it is aimed at.
 * @module tests/support
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SandboxProvider, SandboxUnavailableError, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as BeadTools from '../src/plugin.ts'
import type { Config } from '../src/plugin.ts'

/** The environment every direct `bd` call in the tests uses. Mirrors `BD_BASE_ENV`. */
const BD_ENV = {
  BD_NON_INTERACTIVE: '1',
  CI: '1',
  NO_COLOR: '1',
  BD_NO_PAGER: '1',
  BD_DISABLE_METRICS: '1',
  BD_DISABLE_EVENT_FLUSH: '1',
  BEADS_DOLT_AUTO_START: '0',
  BD_JSON_ENVELOPE: '1',
}

const cleanups: (() => void)[] = []

/**
 * Create a git repository with an initialized beads ledger.
 *
 * `bd init` commits, so the repository needs an identity; the values are
 * deliberately fictional and local to the temp clone.
 * @returns the workspace root.
 */
export function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-beads-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.invalid'])
  git(dir, ['config', 'user.name', 'dsh-beads test'])
  bd(dir, ['init', '--non-interactive', '--skip-agents', '--skip-hooks'])
  return dir
}

/** Create a git repository with NO beads ledger. */
export function makeBareWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-beads-bare-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init', '-q', '.'])
  return dir
}

/** Remove every workspace this module created. */
export function cleanupWorkspaces(): void {
  for (const cleanup of cleanups.splice(0)) cleanup()
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/**
 * Run `bd` directly, outside the plugin — for arranging fixtures and for
 * asserting on the ledger's real state after a tool call.
 * @param cwd - the workspace.
 * @param args - arguments after `bd`.
 * @param actor - the `BEADS_ACTOR` to run as; defaults to a second actor.
 * @returns stdout.
 */
export function bd(cwd: string, args: string[], actor = 'test:direct'): string {
  return execFileSync('bd', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...BD_ENV, BEADS_ACTOR: actor },
  })
}

/**
 * Run `bd` expecting it to fail, and return its diagnostic.
 *
 * stderr when there is one, stdout otherwise — the same order the classifier
 * reads them in, and necessary because some bd commands (`dep add` on an
 * unresolvable id) report only through their JSON body.
 */
export function bdFails(cwd: string, args: string[], actor = 'test:direct'): string {
  try {
    bd(cwd, args, actor)
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string }
    return (failure.stderr ?? '').trim().length > 0 ? failure.stderr! : failure.stdout ?? ''
  }
  throw new Error(`expected \`bd ${args.join(' ')}\` to fail`)
}

/** Read one bead's raw record straight from the ledger. */
export function readBead(cwd: string, id: string): Record<string, unknown> {
  const parsed = JSON.parse(bd(cwd, ['show', '--id', id, '--json'])) as { data: Record<string, unknown>[] }
  const record = parsed.data[0]
  assert.ok(record !== undefined, `no bead ${id} in the ledger`)
  return record
}

/** Create a bead directly and return its id. */
export function makeBead(cwd: string, args: string[], actor = 'test:direct'): string {
  const parsed = JSON.parse(bd(cwd, ['create', ...args, '--json'], actor)) as { data: { id: string } }
  return parsed.data.id
}

/** A composed harness with the beads tools registered. */
export interface Harness {
  ctx: Context
  workspace: string
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  /** Every confine() the stub sandbox saw. Empty unless `sandbox: 'stub'`. */
  confined: ConfineCall[]
  dispose(): Promise<void>
}

/**
 * A `ctx.sandbox` that records what it was asked to confine and then wraps the
 * argv in a marker the spawned process can be observed running under.
 *
 * The wrapper it returns (`env DSH_BEADS_CONFINED=1 …`) is real and harmless:
 * it proves the plugin spawned the argv confine() HANDED BACK rather than the
 * bead's own, without needing a kernel feature available wherever this runs.
 */
function stubSandbox(record: ConfineCall[]) {
  return class StubSandbox extends SandboxProvider {
    confine(argv: readonly string[], policy: SandboxPolicy) {
      record.push({
        argv: [...argv],
        mode: policy.mode,
        workspaceRoot: policy.workspaceRoot,
        ...policy.sessionId !== undefined ? { sessionId: String(policy.sessionId) } : {},
      })
      return {
        argv: ['env', 'DSH_BEADS_CONFINED=1', ...argv],
        enforcement: 'full' as const,
        denialSignatures: ['permission denied'],
        runnerFailureRules: [],
      }
    }
  }
}

/**
 * A `ctx.sandbox` whose confine() always throws — a host where a provider is
 * mounted but no backend can actually enforce the requested mode. Distinct
 * from mounting nothing at all, and the plugin has to refuse both ways.
 */
export class UnusableSandbox extends SandboxProvider {
  confine(): never {
    throw new SandboxUnavailableError('workspace-write', 'no backend in this test')
  }
}

export interface SetupOptions {
  workspace?: string
  config?: Config
  /** Omit the shell executor to exercise the ctx.subprocess verification fallback. */
  withShell?: boolean
  /**
   * Which `ctx.sandbox` to mount. `local` is the real provider (bwrap/Landlock
   * on this host), `none` mounts nothing, `unusable` mounts a provider whose
   * confine() always throws, and `stub` records every confine() call so a test
   * can assert the argv was actually wrapped.
   */
  sandbox?: 'local' | 'none' | 'stub' | 'unusable'
  /** The session id the fake agent carries; becomes `dsh:<id>` as the actor. */
  sessionId?: string
}

/** One recorded `confine()` call from the stub sandbox. */
export interface ConfineCall {
  argv: string[]
  mode: string
  workspaceRoot: string
  sessionId?: string
}

let callSequence = 0

/**
 * Compose the plugin with real dsh services and a fake calling agent.
 * @param options - workspace, config, and which services to mount.
 * @returns the harness.
 */
export async function setup(options: SetupOptions = {}): Promise<Harness> {
  const workspace = options.workspace ?? makeWorkspace()
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
    await ctx.plugin(AgentRegistry),
  ]
  if (options.withShell !== false) fibers.push(await ctx.plugin(LocalBashExecutor))
  const confined: ConfineCall[] = []
  const sandbox = options.sandbox ?? 'local'
  if (sandbox === 'local') fibers.push(await ctx.plugin(LocalSandboxProvider))
  if (sandbox === 'stub') fibers.push(await ctx.plugin(stubSandbox(confined)))
  if (sandbox === 'unusable') fibers.push(await ctx.plugin(UnusableSandbox))
  fibers.push(await ctx.plugin(BeadTools, { workspaceRoot: workspace, graceMs: 2_000, ...options.config }))

  const scope = ctx.plugin(() => {})
  const id = SessionId(options.sessionId ?? 'session-under-test')
  const agent = {
    id,
    ctx: scope.ctx,
    status: 'running',
    inject: () => undefined,
    followup: () => undefined,
    session: {
      id,
      header: { version: 0, id, createdAt: 0, cwd: workspace },
      append: (type: string, data: unknown) => ({ type, data, seq: 1, time: Date.now() }),
    },
  } as unknown as Agent
  const detach = ctx.agents.register(agent)
  const signal = new AbortController().signal

  return {
    ctx,
    workspace,
    confined,
    call: (toolName, args) => ctx.tools.execute({
      callId: CallId(`call-${(callSequence += 1)}`),
      name: toolName,
      arguments: args,
      signal,
      agent,
    }),
    dispose: async () => {
      detach()
      await scope.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

/**
 * Assert a tool call succeeded and return its canonical value.
 * @param result - the materialized tool outcome.
 * @returns the canonical value as a record.
 */
export function value(result: ToolExecutionResult): Record<string, unknown> {
  assert.equal(result.isError, false, `expected success, got ${JSON.stringify(result.error)}`)
  return result.value as Record<string, unknown>
}

/** Join a tool result's model-facing text blocks. */
export function text(result: ToolExecutionResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

/** The beads a `{kind:'beads'}` value carried. */
export function beads(result: ToolExecutionResult): Record<string, unknown>[] {
  const canonical = value(result)
  assert.equal(canonical.kind, 'beads', `expected beads, got ${JSON.stringify(canonical)}`)
  return canonical.beads as Record<string, unknown>[]
}
