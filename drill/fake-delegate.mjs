#!/usr/bin/env node
/**
 * A minimal ACP agent that plays the delegate in the delegation drill.
 *
 * It is registered as a real consult profile and driven by the real broker over
 * real JSON-RPC stdio, so nothing about the transport is simulated — only the
 * model is.
 *
 * This is deliberately NOT dsh-consult's own `drill/fake-delegate.mjs`. That
 * one is built for the steer loop: it reports blocked and then leaves its turn
 * OPEN forever, waiting to be steered. This drill proves a different chain — a
 * delegation that reports and then FINISHES, so the ledger gets both a report
 * note and a terminal note — so it needs a delegate that ends its turn.
 *
 * The scenario, in one beat: on the first `session/prompt`, echo a marker
 * proving the bead's own context packet arrived, shell out to `consult report`
 * so a real report travels the real event path, then end the turn with a final
 * answer.
 *
 * It spawns the report subprocess itself rather than asking the client for
 * permission, which is exactly how a real ACP agent differs — so fake mode
 * proves the plumbing carries a report, not that a real delegate is able to
 * emit one. `DRILL_CONSULT_BIN` carries the consult executable in through the
 * profile record's own `env`; the job id and workspace arrive automatically as
 * CONSULT_PARENT_JOB / CONSULT_WORKSPACE.
 */

import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = 1

/** What the delegate reports upward, and what the drill looks for in the note. */
const REPORT_MESSAGE = 'the retry helper is referenced in three places, not one'

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const chunk = (sessionId, text) => write({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
})

const agentIdentity = {
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
  agentInfo: { name: 'dsh-beads-drill-delegate', version: '1.0.0' },
}

/** Flatten an ACP prompt's content blocks into one string. */
function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : []
  return blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
}

/**
 * Report upward, exactly as a real delegate would mid-turn.
 *
 * `DRILL_CONSULT_BIN` is spawned directly rather than through `node`: an
 * installed consult is a native executable, and only a source checkout would
 * need an interpreter.
 */
function report(onDone) {
  const bin = process.env.DRILL_CONSULT_BIN
  if (bin === undefined) {
    process.stderr.write('drill delegate: DRILL_CONSULT_BIN is not set; cannot report\n')
    onDone()
    return
  }
  const child = spawn(bin, ['report', '--type', 'discovery', '--message', REPORT_MESSAGE], {
    cwd: process.env.CONSULT_WORKSPACE ?? process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (data) => process.stderr.write(`drill delegate report: ${data}`))
  child.on('error', (error) => {
    process.stderr.write(`drill delegate report failed: ${error.message}\n`)
    onDone()
  })
  // The turn ends only after the report has actually been delivered, so the
  // drill never races a terminal transition against the report it is waiting
  // for.
  child.on('close', () => onDone())
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      write({ jsonrpc: '2.0', id: message.id, result: agentIdentity })
      return
    case 'session/new':
      write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'drill-session-1' } })
      return
    case 'session/resume':
    case 'session/load':
      write({ jsonrpc: '2.0', id: message.id, result: { sessionId: message.params?.sessionId } })
      return
    case 'session/cancel':
      write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'cancelled' } })
      return
    case 'session/prompt': {
      const sessionId = message.params?.sessionId
      // Proof the bead's own packet reached the delegate: it can only echo the
      // bead id if the packet carried it.
      const seen = /You have claimed bead (\S+)\./.exec(promptText(message.params))
      chunk(sessionId, `reading the packet for ${seen === null ? '(no bead id in the prompt!)' : seen[1]}`)
      report(() => {
        chunk(sessionId, `I chose the name withRetry. ${REPORT_MESSAGE}.`)
        write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
      })
      return
    }
    default:
      if (message.id !== undefined) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
      }
  }
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  buffered += data
  let index
  while ((index = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    if (line.trim().length === 0) continue
    try {
      handle(JSON.parse(line))
    } catch (error) {
      process.stderr.write(`drill delegate: ${error.message}\n`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
