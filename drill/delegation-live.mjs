#!/usr/bin/env node
/**
 * The delegation drill: a real bead, a real delegation, and a real ledger
 * writing itself as the delegation runs.
 *
 * The unit tests drive `bead_delegate` over a STUB delegation service, which
 * proves the tool needs nothing beyond the seam but proves nothing about the
 * seam's real implementation. This drill closes that gap. Nothing here is
 * stubbed except, in default mode, the delegate agent itself:
 *
 *   - a real git repository with a real `bd` ledger, created and thrown away
 *   - the real dsh tool registry, subprocess seam, and sandbox provider
 *   - the real `@aubwang/dsh-consult` provider driving the real `consult` CLI
 *   - a real background delegation, with real events coming back
 *
 * What is being proved is the chain the ledger depends on:
 *
 *   a. bead_delegate claims the bead and attributes it to the delegation
 *   b. the delegate receives the bead's own context packet as its prompt
 *   c. reports the delegate makes are written onto the bead, framed
 *   d. the terminal transition is recorded, and the bead is STILL OPEN
 *   e. bead_close still refuses until the bead's own verification passes
 *
 * Two modes. By default the delegate is this package's own
 * `drill/fake-delegate.mjs`, so the loop is deterministic and free. With
 * `DRILL_PROFILE=<name>` it is the REAL agent that profile names, copied out
 * of the user's own consult registry so authentication is exercised as it
 * actually is. Real mode spends that agent's tokens, so the bead is tiny, the
 * prompt asks for one line, and nothing retries.
 *
 * Usage, from this package's directory (after `pnpm build`):
 *   node drill/delegation-live.mjs
 *   DRILL_PROFILE=codex node drill/delegation-live.mjs
 *
 * Environment:
 *   DRILL_PROFILE          real consult profile to dogfood against; absent = fake delegate
 *   DRILL_CONSULT_BIN      consult executable (default: `consult` on PATH)
 *   DRILL_CONSULT_DATA_DIR reuse a prepared registry instead of copying one
 *   DRILL_REPORT_WAIT_MS   bound for the first report note to land
 *   DRILL_FINISH_WAIT_MS   bound for the terminal note to land
 *   DRILL_KEEP             set to keep the temporary workspace for inspection
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ConsultDelegation } from '@aubwang/dsh-consult/provider'
import * as BeadTools from '../lib/index.js'

const run = promisify(execFile)
const CONSULT_BIN = process.env.DRILL_CONSULT_BIN ?? 'consult'
const REAL_PROFILE = process.env.DRILL_PROFILE
const LIVE = REAL_PROFILE !== undefined
const FAKE_DELEGATE = fileURLToPath(new URL('./fake-delegate.mjs', import.meta.url))

// A real agent's turn is a network round trip; the fake one is a setTimeout.
const REPORT_WAIT_MS = Number(process.env.DRILL_REPORT_WAIT_MS ?? (LIVE ? '300000' : '90000'))
const FINISH_WAIT_MS = Number(process.env.DRILL_FINISH_WAIT_MS ?? (LIVE ? '600000' : '120000'))

/** The environment every direct `bd` call here uses; mirrors the plugin's own. */
const BD_ENV = {
  BD_NON_INTERACTIVE: '1',
  CI: '1',
  NO_COLOR: '1',
  BD_NO_PAGER: '1',
  BD_DISABLE_METRICS: '1',
  BD_DISABLE_EVENT_FLUSH: '1',
  BEADS_DOLT_AUTO_START: '0',
  BD_JSON_ENVELOPE: '1',
  BEADS_ACTOR: 'drill:setup',
}

const proven = []
const say = (text) => process.stdout.write(`${text}\n`)
const ok = (label) => { proven.push(label); say(`  PASS  ${label}`) }

function check(condition, message) {
  if (!condition) throw new Error(message)
}

async function until(probe, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const found = await probe()
    if (found !== undefined && found !== false) return found
    last = found
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${last === undefined ? '' : ` (last: ${last})`}`)
}

async function bd(cwd, args) {
  const { stdout } = await run('bd', args, { cwd, env: { ...process.env, ...BD_ENV } })
  return stdout
}

async function readBead(cwd, id) {
  const parsed = JSON.parse(await bd(cwd, ['show', '--id', id, '--json']))
  return parsed.data[0]
}

/**
 * Copy one real consult profile into a throwaway registry, so the drill
 * exercises the user's real authentication without writing to their registry.
 */
async function prepareRegistry(dir) {
  if (process.env.DRILL_CONSULT_DATA_DIR !== undefined) return process.env.DRILL_CONSULT_DATA_DIR
  const dataDir = path.join(dir, 'consult-data')
  await fs.mkdir(dataDir, { recursive: true })
  if (LIVE) {
    const sourceDir = process.env.DRILL_SOURCE_DATA_DIR ?? process.env.CONSULT_DATA_DIR ?? path.join(os.homedir(), '.consult')
    const { selectProfileRegistry } = await import('/home/dev/dsh-consult/drill/profiles.ts')
    const source = JSON.parse(await fs.readFile(path.join(sourceDir, 'profiles.json'), 'utf8'))
    await fs.writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify(selectProfileRegistry(source, REAL_PROFILE), null, 2))
    return dataDir
  }
  // Fake mode: one profile whose "agent" is this drill's ACP fake delegate.
  // The record shape is consult's own installed-profile shape (registryId,
  // binary, args, env) — a different one parses as PROFILES_MALFORMED.
  await fs.writeFile(path.join(dataDir, 'profiles.json'), `${JSON.stringify({
    schemaVersion: 1,
    default: 'drill',
    hostDefaults: {},
    profiles: {
      drill: {
        registryId: 'opencode',
        binary: process.execPath,
        args: [FAKE_DELEGATE],
        env: { DRILL_CONSULT_BIN: CONSULT_BIN },
        installedAt: new Date().toISOString(),
      },
    },
  }, null, 2)}\n`)
  return dataDir
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-beads-drill-'))
  let ctx
  let jobId
  try {
    say(`workspace: ${dir}`)
    say(`mode: ${LIVE ? `LIVE against consult profile ${REAL_PROFILE}` : 'fake delegate (deterministic, free)'}`)

    // 1. A real repository with a real ledger, and one bead whose verification
    //    CANNOT pass — that is what proves the close still gates at the end.
    await run('git', ['init', '-q', '.'], { cwd: dir })
    await run('git', ['config', 'user.email', 'drill@example.invalid'], { cwd: dir })
    await run('git', ['config', 'user.name', 'dsh-beads drill'], { cwd: dir })
    await bd(dir, ['init', '--non-interactive', '--skip-agents', '--skip-hooks'])
    // The LIVE description has to TEACH the report, because a real agent has
    // no reason to guess that reporting upward is available — and a bead
    // specified well enough to work on is precisely one that never gets
    // blocked, so nothing would provoke a report on its own. Observed: the
    // first live run reached the delegate, did the work, and finished without
    // ever reporting. The fake delegate always reports, so only live mode
    // needs this.
    const description = LIVE
      ? [
        'The codebase needs one convention for the retry helper name: `retry` or `withRetry`.',
        '',
        'Before you answer, run this exact command once:',
        '  consult report --type discovery --message "checked the call sites"',
        'The `consult` CLI is on your PATH and CONSULT_PARENT_JOB / CONSULT_WORKSPACE are already set in your',
        'environment, so it needs no other arguments. If your sandbox blocks it, retry with escalated permissions —',
        'it is expected and approved.',
        '',
        'Then reply with ONE line naming the convention you would choose. Do not read or write any files.',
      ].join('\n')
      : 'The codebase needs one convention for the retry helper name.'
    const created = JSON.parse(await bd(dir, [
      'create', '--title', 'Name the retry helper',
      '--description', description,
      '--acceptance', 'One name is chosen and written down.',
      '--metadata', JSON.stringify({ verify: ['test -f DECISION-RECORDED'] }),
      '--json',
    ]))
    const beadId = created.data.id
    say(`bead: ${beadId}`)

    // Before spending a token: ask the BINARY whether it can exec a report,
    // rather than trusting its version. A consult without `reportExec` cannot
    // land step c no matter how well the prompt is written, and finding that
    // out after a four-minute timeout teaches nothing.
    if (LIVE) {
      const { stdout } = await run(CONSULT_BIN, ['capabilities', '--json'])
      const features = JSON.parse(stdout).features ?? {}
      check(features.reportExec === true,
        'this consult build cannot exec a delegate report (features.reportExec is not true), so step c can never pass. '
        + 'Point DRILL_CONSULT_BIN at a build that has it.')
    }

    // 2. The real composition: real dsh services, real consult provider.
    const dataDir = await prepareRegistry(dir)
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalSandboxProvider)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ConsultDelegation, {
      consultPath: CONSULT_BIN,
      cwd: dir,
      dataDir,
      sandbox: 'inherit',
      defaultProfile: LIVE ? REAL_PROFILE : 'drill',
    })
    await ctx.plugin(BeadTools, { workspaceRoot: dir })

    const sessionId = SessionId('drill-session')
    const agent = {
      id: sessionId,
      ctx: ctx.plugin(() => {}).ctx,
      status: 'running',
      inject: () => undefined,
      followup: () => undefined,
      session: { id: sessionId, header: { version: 0, id: sessionId, createdAt: 0, cwd: dir }, append: () => ({}) },
    }
    ctx.agents.register(agent)
    let calls = 0
    const call = (name, args) => ctx.tools.execute({
      callId: CallId(`drill-${(calls += 1)}`),
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent,
    })

    // 3. Delegate the bead.
    //
    // LIVE mode delegates in WRITE mode, and that is load-bearing rather than
    // incidental: codex only asks to escalate a blocked command when it is
    // running in write mode, and its read-only mode declines to ask at all, so
    // a read-only real delegate can never get `consult report` to land.
    // (Documented in dsh-consult's own live-dogfood note; confirmed here by two
    // read-only live runs that reached the delegate and finished without ever
    // reporting.) Fake mode stays read-only because the scripted delegate
    // spawns its own subprocess and asks nobody.
    const result = await call('bead_delegate', { id: beadId, mode: LIVE ? 'write' : 'read-only' })
    check(result.isError === false, `bead_delegate failed: ${JSON.stringify(result.error)}`)
    check(result.value.kind === 'delegated', `expected a delegation, got ${JSON.stringify(result.value)}`)
    jobId = result.value.jobId
    say(`delegation: ${jobId} (reports expected: ${result.value.reportsExpected})`)
    ok('a. bead_delegate queued a real delegation')

    const afterClaim = await readBead(dir, beadId)
    check(afterClaim.status === 'in_progress', `bead should be in_progress, was ${afterClaim.status}`)
    check(afterClaim.assignee === `delegate:${jobId}`, `bead should be attributed to the delegation, was ${afterClaim.assignee}`)
    check(/Delegated as /.test(afterClaim.notes ?? ''), 'the queued note should be on the bead')
    ok('b. the ledger records the delegation as the holder')

    if (result.value.reportsExpected) {
      // A real agent may simply not report: it is instructed to, but nothing
      // compels it, and a bead specified well enough to work on is one that
      // never gets blocked. So the wait races the report against the
      // delegation FINISHING without one, and says which happened — "the agent
      // ignored the instruction" is a prompt problem and must not read as "the
      // plumbing broke". Observed live: reported on one run, finished silently
      // on two others, with the same prompt.
      const outcome = await until(async () => {
        const notes = (await readBead(dir, beadId)).notes ?? ''
        if (/Delegate report from /.test(notes)) return { reported: true, notes }
        if (/Delegation .* ended: /.test(notes)) return { reported: false, notes }
        return undefined
      }, 'a delegate report, or the delegation to finish without one', REPORT_WAIT_MS)
      if (outcome.reported) {
        check(/<untrusted-delegate-report>/.test(outcome.notes), 'the report must be framed as untrusted data')
        say(`  report note:\n${outcome.notes.split('\n').slice(-6).map((line) => `    | ${line}`).join('\n')}`)
        ok('c. a delegate report was written onto the bead, framed')
      } else {
        say('  NOTE  the delegate finished without ever reporting, so step c was not exercised.')
        say('        That is the agent declining an instruction, not a defect in the report path;')
        say('        fake mode exercises the same path deterministically.')
      }
    } else {
      say('  (provider reports no interim-report capability; skipping step c)')
    }

    const terminal = await until(async () => {
      const bead = await readBead(dir, beadId)
      return /Delegation .* ended: /.test(bead.notes ?? '') ? bead.notes : undefined
    }, 'the terminal note to land on the bead', FINISH_WAIT_MS)
    say(`  terminal note:\n${terminal.split('\n').slice(-4).map((line) => `    | ${line}`).join('\n')}`)
    ok('d. the terminal transition was recorded on the bead')

    const stillOpen = await readBead(dir, beadId)
    check(stillOpen.status !== 'closed', 'a finished delegation must NOT close the bead')
    ok('d2. the bead is still open after the delegation finished')

    // 4. The whole point: the close is decided by VERIFICATION, not by the
    //    delegate's say-so. Which way it goes depends on the delegate's
    //    authority, and both directions prove the same thing:
    //
    //    - read-only (fake mode): the delegate cannot create the file the bead
    //      demands, so the close is refused however confidently it reports.
    //    - write (live mode): the delegate can SEE its own verify list — the
    //      packet carries it deliberately — and a capable one satisfies it.
    //      The close then succeeds, and the evidence comment is what proves
    //      the commands actually ran rather than being taken on trust.
    //
    //    Asserting only the refusal would have made this drill a test of the
    //    delegate's authority rather than of the ledger's gate.
    const close = await call('bead_close', { id: beadId, reason: 'The delegate reported that it chose a name.' })
    check(close.isError === false, `bead_close threw: ${JSON.stringify(close.error)}`)
    const afterClose = await readBead(dir, beadId)
    if (close.value.kind === 'verification-failed') {
      check(afterClose.status !== 'closed', 'a refused close must leave the bead open')
      ok('e. bead_close refused: the delegation produced work, not evidence')
    } else if (close.value.kind === 'closed') {
      check(afterClose.status === 'closed', 'a successful close should have closed the bead')
      check(close.value.verified.length > 0,
        `the close must have been earned by verification, not waved through: ${JSON.stringify(close.value)}`)
      const withComments = JSON.parse(await bd(dir, ['show', '--id', beadId, '--json', '--include-comments']))
      const evidence = (withComments.data[0].comments ?? []).map((entry) => entry.text).join('\n')
      check(/Verification passed/.test(evidence), `no evidence comment was recorded: ${evidence.slice(0, 300)}`)
      say(`  evidence comment:\n${evidence.split('\n').map((line) => `    | ${line}`).join('\n')}`)
      ok('e. the delegate satisfied the bead\'s own verification, and the close recorded the evidence')
    } else {
      throw new Error(`unexpected close outcome: ${JSON.stringify(close.value).slice(0, 300)}`)
    }

    say(`\n${proven.length} steps proven:\n${proven.map((step) => `  - ${step}`).join('\n')}`)
  } finally {
    if (jobId !== undefined && ctx?.delegation !== undefined) {
      await ctx.delegation.cancel(jobId).catch(() => {})
    }
    await ctx?.stop?.().catch?.(() => {})
    if (process.env.DRILL_KEEP === undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    } else {
      say(`kept: ${dir}`)
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`\nDRILL FAILED: ${error?.stack ?? error}\n`)
    process.exit(1)
  },
)
