/**
 * Unit coverage for the CLI-close recognizer.
 *
 * Both directions matter equally. A miss lets an agent close a bead behind the
 * verification gate; a false positive denies a bash call that was never trying
 * to, which is worse in daily use because it breaks work that has nothing to do
 * with beads. The allow cases below are therefore not padding — they are the
 * half of the contract that keeps the guard usable.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findBdClose, splitSegments, tokenize } from '../src/cli-guard.ts'

/** Assert a command is recognized as a close attempt. */
function denies(command: string, expected?: { kind?: string; beadId?: string }): void {
  const found = findBdClose(command)
  assert.ok(found !== undefined, `should have been recognized: ${command}`)
  if (expected?.kind !== undefined) assert.equal(found.kind, expected.kind, command)
  if (expected?.beadId !== undefined) assert.equal(found.beadId, expected.beadId, command)
}

/** Assert a command is left alone. */
function allows(command: string): void {
  assert.equal(findBdClose(command), undefined, `should have been left alone: ${command}`)
}

describe('recognizing a CLI close', () => {
  it('catches the plain forms the AGENTS.md guidance teaches', () => {
    denies('bd close p-1', { kind: 'close', beadId: 'p-1' })
    denies('bd close p-1 --reason "done"', { kind: 'close', beadId: 'p-1' })
    denies('bd close p-1 p-2', { kind: 'close' })
  })

  it('catches the status-closed spelling, which reaches the same end', () => {
    denies('bd update p-1 --status closed', { kind: 'update-closed', beadId: 'p-1' })
    denies('bd update p-1 --status=closed', { kind: 'update-closed' })
    denies('bd update p-1 -s closed', { kind: 'update-closed' })
  })

  it('sees past global flags to the subcommand', () => {
    denies('bd -C /repo close p-1', { beadId: 'p-1' })
    denies('bd --actor me --db /tmp/x close p-1', { beadId: 'p-1' })
    denies('bd --quiet close p-1')
  })

  it('sees past a path-qualified binary', () => {
    denies('/usr/local/bin/bd close p-1')
    denies('./bin/bd close p-1')
    denies('"/opt/my bin/bd" close p-1')
  })

  it('splits on shell operators, so a close riding along is still caught', () => {
    denies('cd /repo && bd close p-1', { beadId: 'p-1' })
    denies('bd ready; bd close p-1')
    denies('bd list || bd close p-1')
    denies('bd show p-1 | cat && bd close p-1')
    denies('bd ready\nbd close p-1')
  })

  it('unwraps a shell wrapper rather than trusting it', () => {
    denies("bash -lc 'bd close p-1'", { beadId: 'p-1' })
    denies('bash -c "bd close p-1"')
    denies("sh -c 'cd /repo && bd close p-1'")
    denies(`bash -lc "bash -c 'bd close p-1'"`)
  })

  it('sees past prefixes that do not change what runs', () => {
    denies('sudo bd close p-1')
    denies('BEADS_ACTOR=me bd close p-1')
    denies('env BEADS_ACTOR=me bd close p-1')
    denies('command bd close p-1')
  })

  it('stops at the recursion bound rather than unwrapping forever', () => {
    // Four levels of nesting is obfuscation, not usage, and the guard says so
    // by declining rather than by spending unbounded work on it.
    allows(`bash -c "bash -c \\"bash -c 'bash -c \\\\\\"bd close p-1\\\\\\"'\\""`)
  })
})

describe('leaving everything else alone', () => {
  it('allows every other bd subcommand', () => {
    for (const command of [
      'bd ready', 'bd ready --json -n 10', 'bd list --status open', 'bd show p-1',
      'bd create --title "x"', 'bd dep add p-1 p-2', 'bd note p-1 "a note"',
      'bd prime', 'bd status', 'bd update p-1 --priority 0',
      'bd update p-1 --status in_progress', 'bd update p-1 --status blocked',
    ]) allows(command)
  })

  it('does not fire on a bd close that is an ARGUMENT rather than a command', () => {
    // The documented rule: only the first word of a segment is the program.
    // This is what keeps the guard out of the way of an agent READING the very
    // AGENTS.md guidance the guard exists to correct.
    allows('grep "bd close" AGENTS.md')
    allows('grep -r "bd close" .')
    allows('echo bd close p-1')
    allows('echo "run bd close p-1 to finish"')
    allows('cat docs/beads.md | grep "bd close"')
    allows('rg "bd close" --files-with-matches')
  })

  it('does not split inside quotes, so a quoted operator cannot forge a segment', () => {
    // A naive operator split turns this into a segment starting with `bd`.
    allows('echo "a && bd close p-1"')
    allows("printf '%s\\n' 'x; bd close p-1'")
  })

  it('allows commands that merely mention a bead id', () => {
    allows('git commit -m "close p-1"')
    allows('bd show p-1 --json')
  })
})

describe('the tokenizer these rules rest on', () => {
  it('keeps a quoted operator inside one segment', () => {
    assert.deepEqual(splitSegments('echo "a && b"'), ['echo "a && b"'])
    assert.deepEqual(splitSegments('a && b'), ['a', 'b'])
    assert.deepEqual(splitSegments('a; b | c'), ['a', 'b', 'c'])
  })

  it('strips quotes from tokens but keeps the spaces they protect', () => {
    assert.deepEqual(tokenize('bd close "a b"'), ['bd', 'close', 'a b'])
    assert.deepEqual(tokenize("bd close 'a b'"), ['bd', 'close', 'a b'])
    assert.deepEqual(tokenize('bd  close   p-1'), ['bd', 'close', 'p-1'])
  })

  it('keeps an empty quoted token, which is a real argument', () => {
    assert.deepEqual(tokenize('bd update p-1 --assignee ""'), ['bd', 'update', 'p-1', '--assignee', ''])
  })
})

describe('what this guard does NOT stop', () => {
  it('is evaded by computing the command name, and that is documented, not fixed', () => {
    // These are in the test suite deliberately: they pin the guard's REAL
    // boundary so nobody later mistakes it for enforcement. A denylist over
    // shell strings cannot see these, and pretending otherwise in the README
    // would be the actual defect.
    allows('$(echo bd) close p-1')
    allows('BD=bd; $BD close p-1')
    allows('python3 -c "import subprocess; subprocess.run([\'bd\',\'close\',\'p-1\'])"')
    allows('./scripts/finish.sh p-1')
    allows('eval "bd close p-1"')
  })
})
