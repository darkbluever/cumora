/**
 * Regression: the "this message is not for you" signal must be the SAME on both
 * runtimes, and it must read the name the human typed — not just the quote.
 *
 * Two defects motivate this file, both observed live in a 6-agent group:
 *
 * 1. BYOA agents got NO addressing signal at all. `turn.ts` (cloud) renders a
 *    `↦ addressed to …` tag next to each line, but the daemon's
 *    `snapshotUnread` rendered only `author: body`. Since `triage-core.ts`
 *    hard-bypasses the cheap gate for any human message ("human message in
 *    group — always engage, no triage gate"), a BYOA agent reached its big
 *    brain with the weakest possible view of who was being addressed. Measured
 *    cost of that: one `@bram` question woke all five agents; the two that
 *    correctly stayed silent still each burned a full ~75K-token turn to work
 *    that out.
 *
 * 2. The cloud tag keyed off the QUOTE ALONE, which inverts the real case.
 *    `sol` asked "@bram 能不能直接在…开发？" while quoting a message kael had
 *    written. Quote-only logic tells bram — the actual addressee — "addressed
 *    to kael, not you", and tells kael "addressed to YOU". Exactly backwards.
 *    An explicitly typed name is a stronger address than the quote it hangs
 *    off, so the name wins and the quote is reported alongside it.
 *
 * Nothing here routes anything: wake fan-out is still pure membership
 * (`scheduler.ts`), and this tag only changes what the agent SEES. Both
 * runtimes import this one function so they cannot drift apart again.
 *
 * Run: node --import tsx --test server/src/__tests__/agent-addressing-tag.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { addressingTag } from '../agents/addressing.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

test('an explicitly named agent is told the message IS for them', () => {
  const tag = addressingTag({ viewerAgentId: 'bram', body: '@bram 能不能直接在这个 worktree 上开发？' })
  assert.match(tag, /YOU/)
  assert.ok(!/not you/.test(tag), `must not hedge at the addressee: ${tag}`)
})

test('a peer who was NOT named is told to stay out', () => {
  const tag = addressingTag({ viewerAgentId: 'kael', body: '@bram 能不能直接在这个 worktree 上开发？' })
  assert.match(tag, /not you/)
  assert.match(tag, /@bram/, 'naming WHO it is for is the whole signal')
  assert.ok(!/YOU/.test(tag), `must not tell a bystander it is theirs: ${tag}`)
})

test('THE regression: a typed name beats the quote it hangs off', () => {
  // sol wrote "@bram …" as a quote-reply to a message kael had authored.
  const msg = { body: '@bram 能不能直接在search-product-serverless这个worktree上开发？', quotedAuthorId: 'kael', quotedAuthorName: 'Kael' }
  assert.match(
    addressingTag({ viewerAgentId: 'bram', ...msg }),
    /YOU/,
    'bram was named — quote-only logic told the real addressee "not you"',
  )
  const kael = addressingTag({ viewerAgentId: 'kael', ...msg })
  assert.match(kael, /not you/, 'kael was only quoted, not asked — this is what made kael answer')
  assert.match(kael, /quotes your message/, 'but do not hide that kael was quoted')
})

test('@all stays a broadcast that includes everyone', () => {
  for (const viewer of ['bram', 'kael']) {
    const tag = addressingTag({ viewerAgentId: viewer, body: '@all standup in 5' })
    assert.match(tag, /@all/)
    assert.match(tag, /YOU/, 'a broadcast is addressed to the viewer too')
    assert.ok(!/not you/.test(tag), `@all must never read as "not you": ${tag}`)
  }
})

test('a bare quote-reply still addresses the quoted author', () => {
  const msg = { body: '这条我认', quotedAuthorId: 'iris', quotedAuthorName: 'Iris' }
  assert.match(addressingTag({ viewerAgentId: 'iris', ...msg }), /YOU/)
  const other = addressingTag({ viewerAgentId: 'nova', ...msg })
  assert.match(other, /not you/)
  assert.match(other, /Iris/, 'render the display name, not the raw id')
})

test('a message addressed to nobody in particular gets no tag', () => {
  assert.equal(addressingTag({ viewerAgentId: 'bram', body: '早，今天先看昨天的回归' }), '')
  // Control, so "" can never pass by accident: the same shape WITH a name tags.
  assert.notEqual(addressingTag({ viewerAgentId: 'bram', body: '@bram 今天先看昨天的回归' }), '')
})

test('the viewer own message gets no tag', () => {
  const body = '@kael 收到'
  assert.equal(
    addressingTag({ viewerAgentId: 'bram', body, isSelf: true }),
    '',
    'telling an agent its own message is addressed to someone else is noise',
  )
  assert.notEqual(addressingTag({ viewerAgentId: 'bram', body }), '', 'control: only isSelf suppresses it')
})

test('system rows get no tag', () => {
  const body = '@bram joined'
  assert.equal(addressingTag({ viewerAgentId: 'bram', body, kind: 'system' }), '')
  assert.notEqual(addressingTag({ viewerAgentId: 'bram', body }), '', 'control: only kind=system suppresses it')
})

test('an email address is not a mention', () => {
  assert.equal(
    addressingTag({ viewerAgentId: 'bram', body: 'ping sol@example.com about the invoice' }),
    '',
    '@ inside a word must not read as an address, or every email makes a bystander think it is theirs',
  )
  assert.match(
    addressingTag({ viewerAgentId: 'bram', body: 'ping @bram about the invoice' }),
    /YOU/,
    'control: the same sentence with a real mention must still tag',
  )
})

test('a longer id starting with the viewer id is not a match', () => {
  assert.equal(
    addressingTag({ viewerAgentId: 'bram', body: '@bramwell take this one' }),
    addressingTag({ viewerAgentId: 'kael', body: '@bramwell take this one' }),
    '@bramwell addresses neither bram nor kael in the same way',
  )
  assert.match(addressingTag({ viewerAgentId: 'bram', body: '@bramwell take this one' }), /not you/)
})

test('the tag is a single line — it rides inline in the glance zone', () => {
  const tag = addressingTag({ viewerAgentId: 'kael', body: '@bram go' })
  assert.ok(tag.length > 0)
  assert.ok(!tag.includes('\n'), 'a newline would break the one-message-per-line digest')
})

test('both runtimes render the tag through this module — no second copy', () => {
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
  // Source assertions, because the alternative is booting a daemon and a pod
  // runtime to read one line of text. They are written against the RENDERED
  // line rather than the mere presence of the import: calling the helper and
  // then dropping its result is the exact regression this file exists for.
  const turn = read('agents/turn.ts')
  assert.match(
    turn,
    /line \+= addressingTag\(/,
    'turn.ts must append the shared tag to the message line it renders',
  )
  // And the old quote-only literal must be gone from the cloud path, or the
  // inverted "addressed to <quoted author>" reading survives alongside the fix.
  assert.ok(
    !turn.includes('(quote-reply — not you'),
    'turn.ts still carries the inlined quote-only tag',
  )

  const daemon = read('agents/computer/daemon.ts')
  assert.match(daemon, /addressingTag\(\{/, 'daemon.ts must call the shared tag, not roll its own')
  const pushed = /lines\.push\(`\s*\[\$\{row\.id\}\][^`]*`\)/.exec(daemon)
  assert.ok(pushed, 'could not find the daemon digest line — update this test with it')
  assert.match(
    pushed[0],
    /\$\{addressed\}/,
    'the daemon computes the tag but must also interpolate it into the line it pushes',
  )
})
