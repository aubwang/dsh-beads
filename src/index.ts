/**
 * `@aubwang/dsh-beads` — the durable work ledger for DeepSeek Harness agents,
 * backed by the `bd` (beads) CLI.
 *
 * dsh decides how an agent executes; beads records what work exists. The repo
 * stays the source of truth for the code itself — this plugin only persists
 * what is expensive to reconstruct from it: intent, ordering, provenance, and
 * the reasoning that would otherwise die with a session.
 * @module @aubwang/dsh-beads
 */

export { apply, name, inject, Config } from './plugin.ts'
export type { Config as BeadsConfig } from './plugin.ts'
export * from './bd-cli.ts'
export * from './bounds.ts'
export * from './packet.ts'
export * from './render.ts'
