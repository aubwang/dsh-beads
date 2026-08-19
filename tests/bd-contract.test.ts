/**
 * Contract checks against the REAL installed `bd`.
 *
 * These are the assertions that would silently rot if the binary on PATH
 * changed underneath the plugin: which JSON framing it emits, which exit codes
 * it uses, and the exact sentences the failure classifier matches on. Every
 * claim the README makes about bd 1.2.2's behaviour has a check here, so
 * "verified against 1.2.2" stays a fact rather than a memory.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, describe, it } from 'node:test'
import { classifyFailure, parseBdJson } from '../src/bd-cli.ts'
import { bd, bdFails, cleanupWorkspaces, makeBareWorkspace, makeBead, makeWorkspace } from './support.ts'

after(cleanupWorkspaces)

function failure(stderr: string, what = 'doing something') {
  return classifyFailure({ exitCode: 1, signal: null, stdout: '', stderr, truncated: false }, what, 4_000)
}

describe('bd 1.2.2 JSON framing', () => {
  it('honors BD_JSON_ENVELOPE=1 — the whole reason the parser prefers it', () => {
    const workspace = makeWorkspace()
    const created = parseBdJson(bd(workspace, ['create', '--title', 'framing probe', '--json']))
    assert.equal(created.mode, 'envelope')
    assert.equal(created.schemaVersion, 1)
    const listed = parseBdJson(bd(workspace, ['list', '--json', '-n', '5']))
    assert.equal(listed.mode, 'envelope')
    assert.ok(Array.isArray(listed.data))
  })

  it('emits the legacy framing when the variable is absent, which the parser also reads', () => {
    const workspace = makeWorkspace()
    const stdout = execFileSync('bd', ['create', '--title', 'legacy probe', '--json'], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, BD_NON_INTERACTIVE: '1', CI: '1', NO_COLOR: '1', BEADS_DOLT_AUTO_START: '0', BD_JSON_ENVELOPE: '' },
    })
    const parsed = parseBdJson(stdout)
    assert.equal(parsed.mode, 'legacy')
    assert.equal((parsed.data as Record<string, unknown>).title, 'legacy probe')
  })

  it('returns an array even for a single bead, which is why every read goes through asRecords', () => {
    const workspace = makeWorkspace()
    const id = makeBead(workspace, ['--title', 'single'])
    assert.ok(Array.isArray(parseBdJson(bd(workspace, ['show', '--id', id, '--json'])).data))
    assert.ok(Array.isArray(parseBdJson(bd(workspace, ['update', id, '--priority', '1', '--json'])).data))
  })
})

describe('bd 1.2.2 diagnostics', () => {
  it('has two different sentences for an uninitialized workspace, and the classifier knows both', () => {
    const workspace = makeBareWorkspace()
    // Resolved from the process cwd — the shape a caller that does not pass -C sees.
    const byCwd = bdFails(workspace, ['ready', '--json'])
    assert.match(byCwd, /no beads database found/)
    assert.equal(failure(byCwd).code, 'not-initialized')
    // Resolved through -C, which is what this plugin always does.
    const byDirectory = bdFails(workspace, ['-C', workspace, 'ready', '--json'])
    assert.match(byDirectory, /cannot use -C directory .*: no beads project found/)
    assert.equal(failure(byDirectory).code, 'not-initialized')
  })

  it('reports a directory that does not exist the same way', () => {
    const stderr = bdFails(makeBareWorkspace(), ['-C', '/definitely/not/a/directory', 'ready', '--json'])
    assert.match(stderr, /no such file or directory/)
    assert.equal(failure(stderr).code, 'not-initialized')
  })

  it('says "already claimed by <actor>" for a contested claim', () => {
    const workspace = makeWorkspace()
    const id = makeBead(workspace, ['--title', 'contested'])
    bd(workspace, ['update', id, '--claim', '--json'], 'first-actor')
    const stderr = bdFails(workspace, ['update', id, '--claim', '--json'], 'second-actor')
    assert.match(stderr, /already claimed by first-actor/)
    const classified = failure(stderr)
    assert.equal(classified.code, 'claim-conflict')
    assert.equal(classified.holder, 'first-actor')
  })

  it('says "no issue found matching" for a bead that does not exist', () => {
    const stderr = bdFails(makeWorkspace(), ['update', 'nope-999', '--priority', '1', '--json'])
    assert.match(stderr, /no issue found matching/)
    assert.equal(failure(stderr).code, 'not-found')
  })

  it('refuses to close an epic with open children, and says so', () => {
    const workspace = makeWorkspace()
    const parent = makeBead(workspace, ['--title', 'epic', '--type', 'epic'])
    makeBead(workspace, ['--title', 'child', '--parent', parent])
    const stderr = bdFails(workspace, ['close', parent, '--reason', 'early', '--json'])
    assert.match(stderr, /open child issue/)
    assert.equal(failure(stderr).code, 'close-refused')
  })

  it('refuses to close a bead blocked by open dependencies, and says so differently', () => {
    const workspace = makeWorkspace()
    const blocked = makeBead(workspace, ['--title', 'blocked'])
    const blocker = makeBead(workspace, ['--title', 'blocker'])
    bd(workspace, ['dep', 'add', blocked, blocker, '--json'])
    const stderr = bdFails(workspace, ['close', blocked, '--reason', 'early', '--json'])
    assert.match(stderr, /blocked by open issues/)
    assert.equal(failure(stderr).code, 'close-refused')
  })

  it('uses exit 1 for everything, including the usage errors other CLIs give 2 to', () => {
    const workspace = makeWorkspace()
    for (const args of [['list', '--bogus-flag'], ['definitely-not-a-command'], ['create']]) {
      try {
        bd(workspace, args)
        assert.fail(`expected \`bd ${args.join(' ')}\` to fail`)
      } catch (error) {
        assert.equal((error as { status?: number }).status, 1, args.join(' '))
      }
    }
  })
})

describe('bd 1.2.2 metadata and worktrees', () => {
  it('MERGES --metadata rather than replacing it, which is what makes bead_update --verify non-destructive', () => {
    const workspace = makeWorkspace()
    const id = makeBead(workspace, ['--title', 'has other metadata', '--metadata', JSON.stringify({ verify: ['true'], team: 'platform' })])
    bd(workspace, ['update', id, '--metadata', JSON.stringify({ verify: ['npm test'] }), '--json'])
    const metadata = JSON.parse(bd(workspace, ['show', '--id', id, '--json'])).data[0].metadata as Record<string, unknown>
    assert.deepEqual(metadata, { verify: ['npm test'], team: 'platform' })
  })

  it('resolves a linked worktree back to the main workspace, so both share one ledger', () => {
    const workspace = makeWorkspace()
    const id = makeBead(workspace, ['--title', 'filed in the main worktree'])
    execFileSync('git', ['add', '-A'], { cwd: workspace, stdio: 'pipe' })
    try {
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: workspace, stdio: 'pipe' })
    } catch {
      // `bd init` already committed; nothing further to record.
    }
    const linked = `${workspace}-linked`
    execFileSync('git', ['worktree', 'add', '-q', linked, '-b', 'wt'], { cwd: workspace, stdio: 'pipe' })
    try {
      const context = JSON.parse(bd(workspace, ['-C', linked, 'context', '--json'])).data as Record<string, unknown>
      assert.equal(context.repo_root, workspace, 'the worktree must resolve back to the main workspace')
      const listed = JSON.parse(bd(workspace, ['-C', linked, 'list', '--json', '-n', '10'])).data as { id: string }[]
      assert.ok(listed.some((entry) => entry.id === id), 'the worktree must see the main workspace\'s beads')
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: workspace, stdio: 'pipe' })
    }
  })
})

describe('bd 1.2.2 claim atomicity', () => {
  it('produces exactly one winner when several actors race for one bead', async () => {
    const workspace = makeWorkspace()
    const id = makeBead(workspace, ['--title', 'contested'])
    const results = await Promise.all(['a', 'b', 'c', 'd'].map(async (actor) => {
      try {
        bd(workspace, ['update', id, '--claim', '--json'], `racer-${actor}`)
        return 'won'
      } catch {
        return 'lost'
      }
    }))
    assert.equal(results.filter((outcome) => outcome === 'won').length, 1, results.join(','))
  })

  it('does not fail under concurrent writes — it serializes them, which is why the retry is for OUT-OF-PROCESS holders', async () => {
    const workspace = makeWorkspace()
    const outcomes = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      try {
        makeBead(workspace, ['--title', `concurrent ${index}`])
        return 'ok'
      } catch (error) {
        return String((error as { stderr?: string }).stderr ?? error)
      }
    }))
    assert.deepEqual(new Set(outcomes), new Set(['ok']), outcomes.join('\n'))
  })
})
