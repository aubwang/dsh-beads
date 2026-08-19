/**
 * The context packet: everything an agent needs to start work on a bead it just
 * claimed, assembled synchronously from the claim's own result.
 *
 * ## Why the packet is the claim's return value
 *
 * A claim is the moment an agent stops choosing and starts working, and it is
 * the only moment at which the ledger knows more about the task than the agent
 * does. Handing the packet back from `bead_start` — rather than making the
 * agent follow up with `bead_show`, or pushing it in asynchronously — means the
 * agent cannot begin without it and cannot spend a turn re-fetching it.
 *
 * ## Why it is deliberately small
 *
 * The packet is NOT a knowledge graph. It carries the claimed bead's own prose,
 * its verification requirements, and a one-line pointer to each neighbour. It
 * does not walk the dependency graph, does not hydrate neighbour descriptions,
 * and does not summarize history. The design rule for the whole plugin —
 * persist what is expensive to reconstruct, derive what is cheap — applies here
 * too: an agent that needs a neighbour's detail can ask for it with `bead_show`
 * and pay for it then, whereas a packet that pre-fetches every neighbour makes
 * every claim pay for detail most claims never read.
 *
 * A hard byte ceiling sits on top of all of it, because a bead is written by
 * other agents and nothing stops one from pasting a stack trace into a
 * description.
 * @module @aubwang/dsh-beads/packet
 */

import { boundText } from './bounds.ts'
import type { Bead } from './bd-cli.ts'
import { edgeLine, frameBeadText } from './render.ts'

/** The assembled packet, both as structure and as the text the model reads. */
export interface ContextPacket {
  bead: Bead
  /** Rendered packet, bounded to the configured ceiling. */
  text: string
  /** True when the ceiling clipped the rendered packet. */
  truncated: boolean
}

/**
 * Assemble the packet for a freshly claimed bead.
 * @param bead - the claimed bead, already field-bounded by `projectBead`.
 * @param maxBytes - ceiling for the rendered packet.
 * @returns the packet.
 */
export function buildPacket(bead: Bead, maxBytes: number): ContextPacket {
  const sections: string[] = [
    `You have claimed bead ${bead.id}. It is now in_progress and assigned to you. `
    + 'Everything below came out of the shared ledger.',
    summary(bead),
  ]
  if (bead.verify !== undefined && bead.verify.length > 0) {
    sections.push([
      `Before this bead can be closed, bead_close will run ${bead.verify.length} verification `
      + `command${bead.verify.length === 1 ? '' : 's'} declared on it, and refuse the close if any fails:`,
      ...bead.verify.map((command) => `  ${command}`),
      'These are the bead\'s own stated requirements. Treat them as the definition of done.',
    ].join('\n'))
  }
  const prose = proseSections(bead)
  sections.push(...prose)
  if (bead.dependencies !== undefined && bead.dependencies.length > 0) {
    sections.push([
      'Related beads (one line each — read one with bead_show if you need its detail):',
      ...bead.dependencies.map(edgeLine),
    ].join('\n'))
  }
  if (prose.length === 0) {
    sections.push('This bead carries no description, acceptance criteria, design notes, or notes. '
      + 'If the work turns out to be underspecified, record what you learn on the bead with bead_update rather than only in your own reasoning.')
  }
  sections.push('While you work: record decisions, rejected approaches, and surprises on this bead with bead_update. '
    + 'If you discover separate work, file it with bead_create and link it back with the discovered-from dependency type '
    + 'so whoever reads it later knows where it came from.')
  const rendered = sections.join('\n\n')
  const bounded = boundText(rendered, maxBytes, 'head')
  return { bead, text: bounded.text, truncated: bounded.truncated }
}

function summary(bead: Bead): string {
  const facts = [`id: ${bead.id}`, `title: ${JSON.stringify(bead.title)}`, `status: ${bead.status}`]
  if (bead.type !== undefined) facts.push(`type: ${bead.type}`)
  if (bead.priority !== undefined) facts.push(`priority: P${bead.priority}`)
  if (bead.parent !== undefined) facts.push(`parent: ${bead.parent}`)
  if (bead.labels !== undefined && bead.labels.length > 0) facts.push(`labels: ${bead.labels.join(', ')}`)
  if (bead.createdBy !== undefined) facts.push(`created by: ${bead.createdBy}`)
  return facts.join('\n')
}

function proseSections(bead: Bead): string[] {
  const sections: string[] = []
  if (bead.description !== undefined) sections.push(frameBeadText(bead.id, 'description', bead.description))
  if (bead.acceptance !== undefined) sections.push(frameBeadText(bead.id, 'acceptance criteria', bead.acceptance))
  if (bead.design !== undefined) sections.push(frameBeadText(bead.id, 'design notes', bead.design))
  if (bead.notes !== undefined) sections.push(frameBeadText(bead.id, 'notes', bead.notes))
  return sections
}
