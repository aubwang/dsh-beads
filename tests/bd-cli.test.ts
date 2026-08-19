/**
 * Unit coverage for the CLI adapter: the two JSON framings, the failure
 * classifier, the argv builders, the projection, and the one behaviour that
 * could not be provoked against a real workspace — lock contention — driven
 * through a fake spawn.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  BD_BASE_ENV,
  BdInvocationError,
  asRecords,
  buildBdEnv,
  classifyFailure,
  closeArgs,
  createArgs,
  depArgs,
  extractJsonError,
  gateBdVersion,
  isLockContention,
  listArgs,
  parseBdJson,
  projectBead,
  projectContext,
  readVerify,
  readyArgs,
  runBdSerialized,
  showArgs,
  updateArgs,
  type BdInvocation,
  type BdRun,
} from '../src/bd-cli.ts'

const BUDGETS = { proseBytes: 4_000, maxEdges: 20 }

function run(overrides: Partial<BdRun> = {}): BdRun {
  return { exitCode: 1, signal: null, stdout: '', stderr: '', truncated: false, ...overrides }
}

describe('parseBdJson', () => {
  it('reads the envelope framing BD_JSON_ENVELOPE=1 produces', () => {
    const payload = parseBdJson('{"data": {"id": "p-1"}, "schema_version": 1}')
    assert.equal(payload.mode, 'envelope')
    assert.equal(payload.schemaVersion, 1)
    assert.deepEqual(payload.data, { id: 'p-1' })
  })

  it('reads an envelope whose payload is an array', () => {
    const payload = parseBdJson('{"data": [{"id": "p-1"}], "schema_version": 1}')
    assert.equal(payload.mode, 'envelope')
    assert.deepEqual(payload.data, [{ id: 'p-1' }])
  })

  it('reads the legacy framing: a bare object with schema_version merged in', () => {
    const payload = parseBdJson('{"id": "p-1", "schema_version": 1}')
    assert.equal(payload.mode, 'legacy')
    assert.equal(payload.schemaVersion, 1)
    assert.deepEqual(payload.data, { id: 'p-1', schema_version: 1 })
  })

  it('reads the legacy framing: a bare array with no schema_version at all', () => {
    const payload = parseBdJson('[{"id": "p-1"}]')
    assert.equal(payload.mode, 'legacy')
    assert.equal(payload.schemaVersion, undefined)
    assert.deepEqual(payload.data, [{ id: 'p-1' }])
  })

  it('throws rather than inventing a payload for empty or malformed output', () => {
    assert.throws(() => parseBdJson('   '), /no JSON output/)
    assert.throws(() => parseBdJson('not json'), /not valid JSON/)
  })

  it('normalizes single records and collections to the same list shape', () => {
    assert.equal(asRecords(parseBdJson('{"data": {"id": "a"}}')).length, 1)
    assert.equal(asRecords(parseBdJson('{"data": [{"id": "a"}, {"id": "b"}]}')).length, 2)
    assert.equal(asRecords(parseBdJson('{"data": []}')).length, 0)
    assert.equal(asRecords(parseBdJson('{"data": null}')).length, 0)
  })
})

describe('classifyFailure', () => {
  it('names the holder of a claim conflict', () => {
    const failure = classifyFailure(
      run({ stderr: 'Error claiming p-1: issue already claimed by dsh:other' }),
      'claiming bead p-1',
      4_000,
    )
    assert.equal(failure.code, 'claim-conflict')
    assert.equal(failure.holder, 'dsh:other')
    assert.match(failure.message, /dsh:other/)
  })

  it('recognizes every shape of "there is no ledger here" as the same situation', () => {
    for (const stderr of [
      'Error: cannot use -C directory "/x": no beads project found',
      'Error: cannot use -C directory "/x": stat /x: no such file or directory',
      "Error: no beads database found\nHint: run 'bd where' to inspect the resolved workspace, or 'bd init' to create a new database",
    ]) {
      assert.equal(classifyFailure(run({ stderr }), 'reading', 4_000).code, 'not-initialized', stderr)
    }
  })

  it('recognizes both close refusals bd emits', () => {
    for (const stderr of [
      'cannot close epic p-1: 1 open child issue(s); close children first or use --force to override',
      'cannot close p-1: blocked by open issues [p-2] (use --force to override)',
    ]) {
      assert.equal(classifyFailure(run({ stderr }), 'closing', 4_000).code, 'close-refused')
    }
  })

  it('recognizes a missing bead', () => {
    const failure = classifyFailure(run({ stderr: 'Error fetching x: no issue found matching "x"' }), 'reading', 4_000)
    assert.equal(failure.code, 'not-found')
  })

  it('reads a JSON-only diagnostic off stdout when stderr is empty', () => {
    // This is `bd dep add` on a conflicting edge: exit 1, JSON on stdout,
    // NOTHING on stderr.
    const failure = classifyFailure(
      run({ stdout: '{"data": {"error": "dependency a -> b already exists with type \\"blocks\\""}, "schema_version": 1}' }),
      'linking a to b',
      4_000,
    )
    assert.equal(failure.code, 'rejected')
    assert.match(failure.detail, /already exists with type "blocks"/)
    assert.doesNotMatch(failure.detail, /schema_version/, 'the raw envelope must not reach the model')
  })

  it('throws for command lines this plugin built wrong, rather than blaming the model', () => {
    for (const stderr of ['Error: unknown flag: --bogus', 'Error: unknown command "nope" for "bd"']) {
      assert.throws(() => classifyFailure(run({ stderr }), 'listing', 4_000), BdInvocationError)
    }
  })

  it('classifies bd\'s own lock vocabulary as a busy workspace', () => {
    const failure = classifyFailure(
      run({ stderr: 'error: database is locked\n\nThe Dolt database is locked.\nTry: bd doctor --fix' }),
      'creating a bead',
      4_000,
    )
    assert.equal(failure.code, 'workspace-busy')
  })

  it('bounds the diagnostic it quotes', () => {
    const failure = classifyFailure(run({ stderr: `Error: ${'x'.repeat(5_000)}` }), 'reading', 500)
    assert.ok(Buffer.byteLength(failure.detail, 'utf8') < 700, failure.detail.length.toString())
    assert.match(failure.detail, /truncated/)
  })
})

describe('isLockContention', () => {
  it('matches every phrase bd\'s own isLockError matches', () => {
    for (const phrase of ['database is locked', 'noms lock', 'locked by another dolt process', 'stale LOCK file left behind']) {
      assert.equal(isLockContention(`some prefix: ${phrase}`), true, phrase)
    }
  })

  it('does not match ordinary refusals', () => {
    assert.equal(isLockContention('issue already claimed by dsh:other'), false)
    assert.equal(isLockContention('no beads project found'), false)
  })
})

describe('runBdSerialized', () => {
  const invocation: BdInvocation = {
    command: ['bd'],
    workspaceRoot: '/fake/workspace-retry',
    actor: 'dsh:test',
    maxOutputBytes: 1024,
    graceMs: 100,
  }

  /**
   * A fake spawn is used HERE and nowhere else: twenty concurrent real `bd`
   * writes against one workspace all succeeded, so the embedded engine blocks
   * on the lock rather than erroring, and the error this retry exists for
   * cannot be produced from inside one harness. The fake stands in for the
   * out-of-process holder that can.
   */
  function fakeSpawn(outcomes: BdRun[]): { spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle; calls: SubprocessSpawnSpec[] } {
    const calls: SubprocessSpawnSpec[] = []
    let index = 0
    return {
      calls,
      spawn: (spec) => {
        calls.push(spec)
        const outcome = outcomes[Math.min(index++, outcomes.length - 1)]!
        return {
          done: Promise.resolve({ exitCode: outcome.exitCode, signal: outcome.signal }),
          collected: {
            stdout: { readFrom: () => ({ text: outcome.stdout, lossy: false }) },
            stderr: { readFrom: () => ({ text: outcome.stderr, lossy: false }) },
          },
        } as unknown as SubprocessHandle
      },
    }
  }

  it('retries exactly once on lock contention, then reports the second outcome', async () => {
    const fake = fakeSpawn([
      run({ stderr: 'The Dolt database is locked.' }),
      run({ exitCode: 0, stdout: '{"data": {"id": "p-1"}}' }),
    ])
    const result = await runBdSerialized(fake.spawn, ['create'], invocation, 1)
    assert.equal(result.exitCode, 0)
    assert.equal(fake.calls.length, 2)
  })

  it('gives up after one retry rather than looping', async () => {
    const fake = fakeSpawn([run({ stderr: 'database is locked' })])
    const result = await runBdSerialized(fake.spawn, ['create'], invocation, 1)
    assert.equal(result.exitCode, 1)
    assert.equal(fake.calls.length, 2)
  })

  it('does not retry an ordinary refusal', async () => {
    const fake = fakeSpawn([run({ stderr: 'issue already claimed by dsh:other' })])
    await runBdSerialized(fake.spawn, ['update'], invocation, 1)
    assert.equal(fake.calls.length, 1)
  })

  it('runs one workspace\'s invocations strictly one at a time', async () => {
    let live = 0
    let peak = 0
    const spawn = ((): SubprocessHandle => {
      live += 1
      peak = Math.max(peak, live)
      return {
        done: new Promise((resolve) => setTimeout(() => {
          live -= 1
          resolve({ exitCode: 0, signal: null })
        }, 10)),
        collected: {
          stdout: { readFrom: () => ({ text: '{"data": []}', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      } as unknown as SubprocessHandle
    }) as (spec: SubprocessSpawnSpec) => SubprocessHandle
    const serialized = { ...invocation, workspaceRoot: '/fake/workspace-queue' }
    await Promise.all(Array.from({ length: 6 }, () => runBdSerialized(spawn, ['list'], serialized, 0)))
    assert.equal(peak, 1, `expected serialized invocations, saw ${peak} concurrent`)
  })
})

describe('argv builders', () => {
  it('passes model-authored strings as flag values, never positionally', () => {
    const args = createArgs({ title: '--not-a-flag', description: '-d' })
    assert.equal(args[0], 'create')
    assert.equal(args[1], '--title')
    assert.equal(args[2], '--not-a-flag')
    assert.ok(args.includes('--description'))
  })

  it('encodes verify commands as metadata JSON', () => {
    const args = createArgs({ title: 't', verify: ['npm test', 'tsc --noEmit'] })
    const index = args.indexOf('--metadata')
    assert.deepEqual(JSON.parse(args[index + 1]!), { verify: ['npm test', 'tsc --noEmit'] })
  })

  it('encodes typed deps in bd\'s type:id form', () => {
    const args = createArgs({ title: 't', deps: [{ type: 'discovered-from', id: 'p-1' }, { type: 'blocks', id: 'p-2' }] })
    assert.equal(args[args.indexOf('--deps') + 1], 'discovered-from:p-1,blocks:p-2')
  })

  it('routes free text to bd search and everything else to bd list', () => {
    assert.equal(listArgs({ limit: 5 })[0], 'list')
    const search = listArgs({ limit: 5, text: 'auth' })
    assert.equal(search[0], 'search')
    assert.equal(search[1], '--query')
    assert.equal(search[2], 'auth')
  })

  it('drops the type filter for a search, which bd 1.2.2 does not accept there', () => {
    assert.ok(!listArgs({ limit: 5, text: 'auth', type: 'bug' }).includes('--type'))
    assert.ok(listArgs({ limit: 5, type: 'bug' }).includes('--type'))
  })

  it('passes show ids through --id, so a flag-shaped bead id stays an id', () => {
    assert.deepEqual(showArgs(['gt--xyz', 'p-2'], false), ['show', '--json', '--id', 'gt--xyz', '--id', 'p-2'])
    assert.ok(showArgs(['p-1'], true).includes('--include-comments'))
  })

  it('keeps bd\'s dependent-then-dependency argument order', () => {
    assert.deepEqual(depArgs('add', 'p-1', 'p-2', 'discovered-from'), ['dep', 'add', 'p-1', 'p-2', '--json', '--type', 'discovered-from'])
    // remove matches on the pair; a type would be meaningless.
    assert.deepEqual(depArgs('remove', 'p-1', 'p-2', 'blocks'), ['dep', 'remove', 'p-1', 'p-2', '--json'])
  })

  it('never passes --force when closing', () => {
    assert.ok(!closeArgs('p-1', 'because').includes('--force'))
  })

  it('claims through the flag bd makes atomic', () => {
    assert.ok(updateArgs({ id: 'p-1', claim: true }).includes('--claim'))
    assert.ok(readyArgs({ limit: 1, claim: true }).includes('--claim'))
  })
})

describe('environment', () => {
  it('carries every flag that makes bd behave like a library call', () => {
    const env = buildBdEnv('dsh:s1')
    for (const [key, expected] of Object.entries(BD_BASE_ENV)) assert.equal(env[key], expected, key)
    assert.equal(env.BEADS_ACTOR, 'dsh:s1')
  })

  it('lets managed keys win over deployment passthrough', () => {
    const env = buildBdEnv('dsh:s1', { BEADS_ACTOR: 'spoofed', BD_NON_INTERACTIVE: '0', HTTPS_PROXY: 'http://p' })
    assert.equal(env.BEADS_ACTOR, 'dsh:s1')
    assert.equal(env.BD_NON_INTERACTIVE, '1')
    assert.equal(env.HTTPS_PROXY, 'http://p')
  })
})

describe('projection', () => {
  it('bounds every prose field and flags that it did', () => {
    const bead = projectBead({ id: 'p-1', title: 't', status: 'open', description: 'x'.repeat(9_000) }, { proseBytes: 100, maxEdges: 5 })
    assert.ok(bead !== undefined)
    assert.ok(Buffer.byteLength(bead.description!, 'utf8') < 200)
    assert.equal(bead.truncated, true)
  })

  it('does not split a multi-byte character when bounding', () => {
    const bead = projectBead({ id: 'p-1', title: '🧵'.repeat(50), status: 'open' }, { proseBytes: 10, maxEdges: 5 })
    assert.ok(!bead!.title.includes('�'))
  })

  it('drops a record with no id rather than inventing one', () => {
    assert.equal(projectBead({ title: 't' }, BUDGETS), undefined)
  })

  it('reduces hydrated dependencies to pointers', () => {
    const bead = projectBead({
      id: 'p-1',
      title: 't',
      status: 'open',
      dependencies: [{ id: 'p-2', title: 'dep', status: 'open', dependency_type: 'blocks', description: 'y'.repeat(9_000) }],
    }, BUDGETS)
    assert.deepEqual(bead!.dependencies, [{ id: 'p-2', title: 'dep', status: 'open', type: 'blocks' }])
  })

  it('caps how many edges it carries', () => {
    const dependencies = Array.from({ length: 40 }, (_, index) => ({ id: `p-${index}`, title: 't', status: 'open' }))
    const bead = projectBead({ id: 'p-1', title: 't', status: 'open', dependencies }, { proseBytes: 4_000, maxEdges: 3 })
    assert.equal(bead!.dependencies!.length, 3)
    assert.equal(bead!.truncated, true)
  })
})

describe('readVerify', () => {
  it('reads a list of commands', () => {
    assert.deepEqual(readVerify({ verify: ['a', 'b'] }), ['a', 'b'])
  })

  it('treats a partially unreadable list as absent, never as partly honored', () => {
    assert.equal(readVerify({ verify: ['a', 42] }), undefined)
    assert.equal(readVerify({ verify: ['a', ''] }), undefined)
    assert.equal(readVerify({ verify: 'npm test' }), undefined)
    assert.equal(readVerify({ verify: [] }), undefined)
    assert.equal(readVerify(undefined), undefined)
  })
})

describe('gateBdVersion', () => {
  it('accepts the installed 1.2.2', () => {
    assert.deepEqual(gateBdVersion(parseBdJson('{"data": {"version": "1.2.2"}}')), { ok: true, version: '1.2.2' })
  })

  it('refuses a version whose JSON this plugin has not verified', () => {
    for (const version of ['1.1.9', '2.0.0', '0.9.0']) {
      const gate = gateBdVersion(parseBdJson(JSON.stringify({ data: { version } })))
      assert.equal(gate.ok, false, version)
    }
  })

  it('refuses rather than guessing when there is no version at all', () => {
    assert.equal(gateBdVersion(parseBdJson('{"data": {}}')).ok, false)
  })
})

describe('projectContext', () => {
  it('reads the workspace facts, including whether this is a worktree', () => {
    const context = projectContext(parseBdJson('{"data": {"repo_root": "/r", "beads_dir": "/r/.beads", "backend": "dolt", "database": "r", "is_worktree": true}}'))
    assert.deepEqual(context, { repoRoot: '/r', beadsDir: '/r/.beads', backend: 'dolt', database: 'r', isWorktree: true })
  })
})

describe('extractJsonError', () => {
  it('finds the error in either framing, and nothing where there is none', () => {
    assert.equal(extractJsonError('{"data": {"error": "boom"}}'), 'boom')
    assert.equal(extractJsonError('{"error": "boom", "schema_version": 1}'), 'boom')
    assert.equal(extractJsonError('{"data": [{"id": "a"}]}'), undefined)
    assert.equal(extractJsonError('not json'), undefined)
  })
})
