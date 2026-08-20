/**
 * The two runtime corrections for a workspace whose own AGENTS.md teaches the
 * raw `bd` CLI: the prompt section that claims the ledger, and the pre-execute
 * guard that refuses a CLI close.
 *
 * Both are driven through the REAL registries — the real prompt assembly and
 * the real tool pipeline — because both are integration behaviour. A unit test
 * of the recognizer (see `cli-guard.test.ts`) proves the parsing; only this
 * proves the wiring.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as BeadTools from '../src/plugin.ts'
import { cleanupWorkspaces, comment, makeBareWorkspace, makeBead, readBead, setup, value, type Harness } from './support.ts'

const harnesses: Harness[] = []

async function harness(...args: Parameters<typeof setup>): Promise<Harness> {
  const created = await setup(...args)
  harnesses.push(created)
  return created
}

/**
 * Register a `bash` tool that records what it was asked to run.
 *
 * A real one would need a shell executor and would actually run the command;
 * the point here is the POLICY layer, so this records and returns. If the guard
 * ever fails to deny, the recorded list is how the test notices.
 */
function registerBash(ctx: Context, ran: string[]): void {
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Run a shell command.',
    parameters: { command: { type: 'string', required: true, description: 'The command.' } },
    output: { schema: { type: 'string' }, render: (_args, value_) => [{ type: 'text', text: value_ }] },
    execute: (args) => {
      ran.push(args.command)
      return Promise.resolve('ok')
    },
  }))
}

/** Render the assembled system prompt for one composition. */
async function promptText(h: Harness): Promise<string> {
  return renderPrompt(await h.ctx.systemPrompt.assemble())
}

after(async () => {
  for (const created of harnesses.reverse()) await created.dispose()
  cleanupWorkspaces()
})

describe('the ledger claim in the system prompt', () => {
  it('claims the ledger once a workspace really has one', async () => {
    const h = await harness({ sessionId: 'prompt-yes' })
    // The section is provider-backed and warms asynchronously, so the first
    // assembly may legitimately precede the probe. Assemble until it lands.
    let text = ''
    for (let attempt = 0; attempt < 80 && !text.includes('bead_* tools'); attempt += 1) {
      text = await promptText(h)
      if (!text.includes('bead_* tools')) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.match(text, /issue ledger is managed through the bead_\* tools/)
    assert.match(text, /rather than driving the/)
    assert.match(text, /verification and records evidence/)
    assert.match(text, /discovered-from/)
    assert.match(text, /as they happen/)
  })

  it('says NOTHING when the workspace has no ledger', async () => {
    // The honesty case. A plugin mounted over a directory with no .beads/ must
    // not tell the model there is a ledger here — the guidance would be a lie,
    // and every bead tool would answer not-initialized anyway.
    const h = await harness({ workspace: makeBareWorkspace(), sessionId: 'prompt-no' })
    // Give the probe the same chance to run that the positive case gets.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const text = await promptText(h)
    assert.doesNotMatch(text, /issue ledger/)
    assert.doesNotMatch(text, /bead_\*/)
  })

  it('leaves no empty block behind when it says nothing', async () => {
    const h = await harness({ workspace: makeBareWorkspace(), sessionId: 'prompt-empty' })
    const assembly = await h.ctx.systemPrompt.assemble()
    const section = assembly.sections.find((entry) => entry.name === 'beads:ledger')
    // The section IS registered — it has to be, or a ledger created later could
    // never be claimed — it simply renders to nothing.
    assert.ok(section !== undefined, 'the section should be registered regardless')
    assert.equal(section.text, '')
    assert.doesNotMatch(renderPrompt(assembly), /\n\n\n/, 'an empty section must not leave a gap')
  })

  it('can be turned off by a deployment', async () => {
    const h = await harness({ sessionId: 'prompt-off', config: { announceInPrompt: false } })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const assembly = await h.ctx.systemPrompt.assemble()
    assert.equal(assembly.sections.find((entry) => entry.name === 'beads:ledger'), undefined)
  })

  it('never makes the prompt registry a hard dependency of its own', () => {
    // `ctx.get('systemPrompt')` rather than adding it to `inject`. In THIS
    // harness the difference is currently unobservable — `ToolRuntime` itself
    // declares `static inject = ['systemPrompt']`, so a composition without the
    // prompt registry has no `ctx.tools` either and nothing to mount beads
    // into. The optional form is still the right one: this plugin uses the
    // service opportunistically for two sentences of guidance, and asserting a
    // dependency it does not actually need would be a claim about its
    // requirements that is not true.
    assert.deepEqual([...BeadTools.inject], ['tools', 'subprocess'])
    assert.ok(!BeadTools.inject.includes('systemPrompt'))
  })

  it('works identically with the prompt contribution disabled', async () => {
    // The behavioural half of the same claim: nothing about the tools depends
    // on the section existing.
    const h = await harness({ sessionId: 'no-section', config: { announceInPrompt: false } })
    assert.equal(h.ctx.tools.schemas().filter((schema) => schema.name.startsWith('bead_')).length, 9)
    assert.equal(value(await h.call('bead_create', { title: 'still works' })).kind, 'beads')
  })
})

describe('the CLI-close guard', () => {
  /** Compose a harness with a recording `bash` tool registered. */
  async function withBash(sessionId: string, config = {}): Promise<{ h: Harness; ran: string[] }> {
    const h = await harness({ sessionId, config })
    const ran: string[] = []
    registerBash(h.ctx, ran)
    return { h, ran }
  }

  it('denies every spelling of a CLI close, and the command never runs', async () => {
    const { h, ran } = await withBash('guard-deny')
    for (const command of [
      'bd close p-1',
      'bd update p-1 --status closed',
      'cd /repo && bd close p-1',
      "bash -lc 'bd close p-1'",
      '/usr/local/bin/bd close p-1',
      'bd -C /repo close p-1',
    ]) {
      const result = await h.call('bash', { command })
      assert.equal(result.isError, true, command)
      assert.match(JSON.stringify(result.error), /bead_close/, command)
    }
    assert.deepEqual(ran, [], 'a denied call must never reach the tool body')
  })

  it('explains what bead_close adds, rather than just refusing', async () => {
    const { h } = await withBash('guard-reason')
    const error = JSON.stringify((await h.call('bash', { command: 'bd close p-1' })).error)
    assert.match(error, /bead p-1/, 'the reason should name what it was about to close')
    assert.match(error, /verification commands the bead itself declares/)
    assert.match(error, /evidence/)
    assert.match(error, /AGENTS\.md/, 'it should say why the model was told otherwise')
    assert.match(error, /Every other bd command is unaffected/)
  })

  it('leaves every other bd command alone', async () => {
    const { h, ran } = await withBash('guard-allow')
    const allowed = [
      'bd ready --json',
      'bd list --status open',
      'bd show p-1',
      'bd create --title "x"',
      'bd dep add p-1 p-2',
      'bd update p-1 --priority 0',
      'grep "bd close" AGENTS.md',
      'echo "run bd close p-1 to finish"',
    ]
    for (const command of allowed) {
      assert.equal((await h.call('bash', { command })).isError, false, command)
    }
    assert.deepEqual(ran, allowed)
  })

  it('is off when a deployment turns it off', async () => {
    const { h, ran } = await withBash('guard-off', { guardCliCloses: false })
    assert.equal((await h.call('bash', { command: 'bd close p-1' })).isError, false)
    assert.deepEqual(ran, ['bd close p-1'])
  })

  it('does not touch tools that are not shells', async () => {
    const { h } = await withBash('guard-scope')
    // bead_create's arguments have nothing to do with shell commands, and a
    // guard that inspected every tool's arguments for the substring would deny
    // a bead whose TITLE mentioned the command.
    const created = value(await h.call('bead_create', { title: 'document how bd close works', description: 'bd close p-1' }))
    assert.equal(created.kind, 'beads')
  })

  it('CANNOT deny the plugin its own close', async () => {
    // The failure mode this pins would be silent and total: bead_close runs
    // `bd close` internally, and if that went through the tools registry the
    // guard would deny the very tool it exists to protect. It does not —
    // the plugin spawns through ctx.subprocess, which the pipeline never sees.
    const { h } = await withBash('guard-self')
    const id = makeBead(h.workspace, ['--title', 'closed by the tool', '--metadata', JSON.stringify({ verify: ['true'] })])
    const closed = value(await h.call('bead_close', { id, reason: 'Verified and closed through the tool.' }))
    assert.equal(closed.kind, 'closed')
    assert.equal(readBead(h.workspace, id).status, 'closed')
    // And the evidence path still ran, so the guard cost the tool nothing.
    assert.match(String(comment(h.workspace, id)[0]!.text), /Verification passed/)
  })
})
