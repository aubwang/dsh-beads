/**
 * Bounding helpers.
 *
 * Every string this plugin shows a model came out of a `bd` workspace, which is
 * a shared ledger: titles, descriptions, and notes may have been written by a
 * different agent, a human, or an earlier session, and none of them is under
 * this plugin's control. So nothing reaches a tool result without passing a
 * byte budget first, and the budget is enforced on UTF-8 bytes rather than on
 * `string.length`, because a model's context is paid for in tokens over bytes
 * and a `.slice()` on a multi-byte code point produces mojibake.
 * @module @aubwang/dsh-beads/bounds
 */

/** Result of bounding one text field. */
export interface BoundedText {
  text: string
  truncated: boolean
}

/**
 * Truncate text to a UTF-8 byte budget without splitting a code point,
 * appending a marker when bytes were dropped.
 * @param text - the untrusted input.
 * @param maxBytes - byte budget for the retained text.
 * @param keep - retain the `head` (prose read forwards) or the `tail` (command output read backwards).
 * @returns the bounded text and whether anything was dropped.
 */
export function boundText(text: string, maxBytes: number, keep: 'head' | 'tail'): BoundedText {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return { text, truncated: false }
  const dropped = buffer.byteLength - maxBytes
  if (keep === 'head') {
    const kept = new TextDecoder('utf8', { fatal: false }).decode(buffer.subarray(0, maxBytes)).replace(/�+$/, '')
    return { text: `${kept}\n[truncated: ${dropped} more bytes not shown]`, truncated: true }
  }
  const kept = new TextDecoder('utf8', { fatal: false }).decode(buffer.subarray(buffer.byteLength - maxBytes)).replace(/^�+/, '')
  return { text: `[truncated: ${dropped} earlier bytes not shown]\n${kept}`, truncated: true }
}

/**
 * Keep the last `maxLines` lines of text within a byte budget. Verification
 * output is read backwards — a failing test prints its assertion last — so the
 * tail is what a supervisor needs.
 * @param text - the untrusted input.
 * @param maxLines - line budget.
 * @param maxBytes - byte budget applied after the line budget.
 * @returns the bounded tail.
 */
export function boundLines(text: string, maxLines: number, maxBytes: number): BoundedText {
  const lines = text.replace(/\n$/, '').split('\n')
  const droppedLines = Math.max(0, lines.length - maxLines)
  const kept = droppedLines === 0 ? text : lines.slice(droppedLines).join('\n')
  const bounded = boundText(kept, maxBytes, 'tail')
  return { text: bounded.text, truncated: bounded.truncated || droppedLines > 0 }
}

/**
 * Take the first `maxLines` lines of text within a byte budget, without
 * surrounding whitespace. `bd`'s diagnostics put the actionable sentence first
 * and any hint after it, so an error is read from the head.
 * @param text - the untrusted input.
 * @param maxLines - line budget.
 * @param maxBytes - byte budget applied after the line budget.
 * @returns the bounded head.
 */
export function firstLines(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.trim().split('\n').slice(0, maxLines).join('\n')
  return boundText(lines, maxBytes, 'head').text
}
