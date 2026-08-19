/**
 * "Is this message for me?" — one renderer, both runtimes.
 *
 * Nothing in Cumora routes on addressing. The scheduler wakes every non-muted
 * member of a conversation (`scheduler.ts`), and the cheap triage gate is
 * hard-bypassed for any human message (`triage-core.ts`), so a human line
 * reaches every member's big brain no matter who it names. Whether the peers
 * then stay quiet is decided by the model reading `GLANCE_YIELD_RULES` — which
 * means the ONLY lever on that decision is how clearly the digest says who was
 * being addressed. This module is that lever, and nothing more: it returns a
 * string. It grants no delivery and blocks none.
 *
 * Two things it fixes:
 *
 * - The BYOA daemon rendered no addressing signal at all, while the cloud path
 *   rendered one inline. Same room, same message, two different readings — so
 *   both `turn.ts` and `computer/daemon.ts` now render through here, the same
 *   way `glance-protocol.ts` and `triage-core.ts` are shared.
 *
 * - The cloud tag keyed off the QUOTE, which inverts the common case: asking
 *   "@bram …" as a reply to something kael wrote told bram "addressed to kael"
 *   and kael "addressed to YOU". A typed name is a deliberate address; the
 *   quote is just what the human happened to be looking at. So the name wins,
 *   and the quote is reported next to it rather than instead of it.
 *
 * Mention syntax matches `shouldDeliverToMutedAgent` (`scheduler.ts`) and the
 * inbox SQL: `@` must not sit inside a word (so `sol@example.com` is an email,
 * not an address) and the id must match whole (`@bramwell` is not `@bram`).
 */

export interface AddressingInput {
  /** The agent reading the digest. Without it there is no "you" to speak to. */
  viewerAgentId?: string | null
  body: string
  /** Author of the quoted-original, when this message is a quote-reply. */
  quotedAuthorId?: string | null
  /** Display name of that author — preferred over the raw id in the tag. */
  quotedAuthorName?: string | null
  /** The viewer wrote this message. */
  isSelf?: boolean
  /** `messages.kind`; `system` rows are joins/leaves, not conversation. */
  kind?: string | null
}

const ALL_MENTION_RE = /(?<![\w@])@all(?![\w-])/i
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9_-]+)/g

/** True iff `body` carries an `@all` broadcast token — the author is addressing
 *  the whole room, not just whoever they were replying to. The negative
 *  lookahead on `[\w-]` keeps participant ids like `@allison` or `@all-team`
 *  out. Case-insensitive: the picker inserts lower-case, humans paste anything. */
export function hasAllMention(body: string): boolean {
  return ALL_MENTION_RE.test(body)
}

/** Distinct `@name` handles in the body, in the order the human typed them. */
function mentionsIn(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(MENTION_RE)) {
    const name = m[1]
    if (name.toLowerCase() === 'all') continue
    if (!out.some((seen) => seen.toLowerCase() === name.toLowerCase())) out.push(name)
  }
  return out
}

/** Advice appended to every "not you" tag — it is the whole point of the tag. */
const STAND_DOWN = 'not you; stay quiet unless your angle differs'

/**
 * A single inline fragment to append to one rendered message line, or `''` when
 * the message addresses nobody in particular. Always one line: the digest is
 * one-message-per-line and a newline would break the glance zone.
 */
export function addressingTag(input: AddressingInput): string {
  const viewer = input.viewerAgentId
  if (!viewer || input.isSelf || input.kind === 'system') return ''

  const body = input.body ?? ''
  if (ALL_MENTION_RE.test(body)) return '  📣 addressed to @all (broadcast — that includes YOU)'

  const named = mentionsIn(body)
  const quotesViewer = Boolean(input.quotedAuthorId) && input.quotedAuthorId === viewer

  if (named.some((n) => n.toLowerCase() === viewer.toLowerCase())) {
    return `  ↦ addressed to YOU (@${viewer})`
  }
  if (named.length > 0) {
    const who = named.map((n) => `@${n}`).join(', ')
    // Being quoted is not being asked — but don't hide it either, or the agent
    // can't tell why its own words are on screen.
    const alsoQuoted = quotesViewer ? ', though it quotes your message' : ''
    return `  ↦ addressed to ${who} — ${STAND_DOWN}${alsoQuoted}`
  }

  if (quotesViewer) return '  ↦ addressed to YOU (quote-reply)'
  if (input.quotedAuthorId) {
    const who = input.quotedAuthorName || input.quotedAuthorId
    return `  ↦ addressed to ${who} (quote-reply — ${STAND_DOWN})`
  }
  return ''
}
