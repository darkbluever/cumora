/**
 * Regression: every timestamp an AGENT reads must be in the same wall clock.
 *
 * `turn.ts` renders the wake prompt in the server's LOCAL timezone on purpose
 * (`Now: 2026-08-19 20:21 (Asia/Shanghai)`, and every message time via
 * `localHHmm`) — the comment above that helper records why: it used to render
 * UTC via `toISOString()` and agents disagreed about what time it was.
 *
 * But the agent CLI never got the same treatment. `cumora calendar list`,
 * `calendar create`, `calendar update`, `reminders`, `email threads`,
 * `email show` and `mute` all printed `toISOString()` — bare UTC, with no
 * timezone marker at all. On a +08:00 machine an agent therefore read
 * "now = 20:21" in its prompt and "the event is at 12:21" from its own CLI for
 * the SAME instant, with nothing on screen explaining the 8-hour gap.
 *
 * Worse on the way in: `calendar create --at` is parsed with `new Date(str)`,
 * and JS parses a DATE-ONLY string as UTC midnight while parsing a date-TIME
 * string without an offset as local. So `--at 2026-08-20` and
 * `--at 2026-08-20T00:00` meant two different instants, 8 hours apart, and the
 * help text's only examples ended in `Z` — which is how you get an alarm
 * scheduled at 17:00 local when the agent meant 09:00.
 *
 * These tests are timezone-AGNOSTIC on purpose: they assert the formatters
 * agree with the platform's own local getters rather than with a hardcoded
 * offset, so they pin the behavior on CI (UTC) and on this machine (+08:00).
 *
 * Run: node --import tsx --test server/src/__tests__/agent-local-time.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  localHHmm,
  localStamp,
  localStampTz,
  localTzName,
  parseLocalTimestamp,
} from '../agents/local-time.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const SAMPLE = new Date('2026-08-19T14:20:00Z')

test('localHHmm renders the LOCAL hour, not the UTC hour', () => {
  const expected = `${String(SAMPLE.getHours()).padStart(2, '0')}:${String(SAMPLE.getMinutes()).padStart(2, '0')}`
  assert.equal(localHHmm(SAMPLE), expected)
})

test('localHHmm accepts the ISO strings that come back from the DB driver', () => {
  const out = localHHmm(SAMPLE.toISOString())
  assert.match(out, /^\d{2}:\d{2}$/, 'must render, not return empty')
  assert.equal(out, localHHmm(SAMPLE))
})

test('localStamp renders a full local date-time with no "T" and no "Z"', () => {
  const out = localStamp(SAMPLE)
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.ok(!out.includes('Z'), `a bare Z-less local stamp must not claim UTC: ${out}`)
  assert.ok(out.endsWith(localHHmm(SAMPLE)), 'the time half must agree with localHHmm')
})

test('localStamp uses the LOCAL calendar day', () => {
  // 2026-08-19T18:00Z is already the 20th in +08:00 and still the 19th in UTC.
  // Either way the day must match the platform's own local getter.
  const d = new Date('2026-08-19T18:00:00Z')
  const expectedDay = String(d.getDate()).padStart(2, '0')
  assert.equal(localStamp(d).slice(8, 10), expectedDay)
})

test('localStampTz appends the resolved zone so an agent can never read it as UTC', () => {
  const out = localStampTz(SAMPLE)
  assert.equal(out, `${localStamp(SAMPLE)} (${localTzName()})`)
  assert.equal(localTzName(), Intl.DateTimeFormat().resolvedOptions().timeZone)
})

test('parseLocalTimestamp treats a DATE-ONLY string as LOCAL midnight', () => {
  // This is the trap: `new Date('2026-08-20')` is UTC midnight per spec, i.e.
  // 08:00 local on a +08:00 box. An agent writing `--at 2026-08-20` means the
  // start of its own day.
  const d = parseLocalTimestamp('2026-08-20')
  assert.equal(d?.getHours(), 0, 'must be local midnight')
  assert.equal(d?.getMinutes(), 0)
  assert.equal(d?.getDate(), 20, 'must still be the 20th in local time')
})

test('parseLocalTimestamp keeps an explicit offset authoritative', () => {
  assert.equal(
    parseLocalTimestamp('2026-08-19T14:20:00Z')?.getTime(),
    Date.parse('2026-08-19T14:20:00Z'),
    'a trailing Z means the agent said UTC and meant it',
  )
  assert.equal(
    parseLocalTimestamp('2026-08-19T14:20:00+05:30')?.getTime(),
    Date.parse('2026-08-19T14:20:00+05:30'),
  )
})

test('parseLocalTimestamp reads an offset-less date-TIME as local', () => {
  const d = parseLocalTimestamp('2026-08-20T09:00')
  assert.equal(d?.getHours(), 9, '09:00 with no offset is 09:00 where the agent lives')
  assert.equal(d?.getDate(), 20)
})

test('parseLocalTimestamp accepts a space instead of the "T"', () => {
  const spaced = parseLocalTimestamp('2026-08-20 09:00')
  assert.ok(spaced, 'must parse, not return null')
  assert.equal(spaced.getTime(), parseLocalTimestamp('2026-08-20T09:00')?.getTime())
})

test('parseLocalTimestamp returns null for junk instead of an Invalid Date', () => {
  assert.equal(parseLocalTimestamp('next tuesday'), null)
  assert.equal(parseLocalTimestamp(''), null)
})

// ─── Wiring ──────────────────────────────────────────────────────────────────
// Source assertions, because rendering these lines for real means a live pool,
// a calendar row and a mute row. The helper being correct is worth nothing if
// the surfaces an agent actually reads keep printing UTC next to it.

test('the agent CLI renders no bare-UTC timestamps', () => {
  const cli = read('agents/cli.ts')
  // These two idioms ARE the bug: `toISOString().slice(0,16)` and
  // `toISOString().replace('T',' ')` render an instant as UTC with no marker,
  // which is how an agent read 12:21 for the 20:21 in its own wake prompt.
  assert.ok(
    !/toISOString\(\)\s*\.\s*slice/.test(cli),
    'cli.ts still renders a UTC timestamp via toISOString().slice',
  )
  assert.ok(
    !/toISOString\(\)\s*\.\s*replace\('T'/.test(cli),
    "cli.ts still renders a UTC timestamp via toISOString().replace('T', ' ')",
  )
  assert.match(cli, /localStamp|localStampTz/, 'cli.ts must render through the shared formatter')
})

test('calendar --at is parsed as LOCAL on both create and update', () => {
  const cli = read('agents/cli.ts')
  const parses = cli.match(/parseLocalTimestamp\(/g) ?? []
  assert.ok(
    parses.length >= 3,
    `--at (create), --at (update) and --until must all parse locally; found ${parses.length} call(s)`,
  )
  assert.ok(
    !/const start = new Date\(String\(parsed\.flags\.at\)\)/.test(cli),
    'calendar update still parses --at with new Date, so it disagrees with create',
  )
})

test('the BYOA clock line agrees with the CLI it feeds', () => {
  const daemon = read('agents/computer/daemon.ts')
  assert.ok(
    !daemon.includes('Current time (UTC)'),
    'the daemon told the engine a UTC clock while --at now parses as local — every deadline it computes would be off by the host offset',
  )
  assert.match(daemon, /localStampTz\(new Date\(\)\)/, 'the daemon clock must use the shared formatter')
})

test('the wake prompt clock comes from the shared formatter, not a private copy', () => {
  const turn = read('agents/turn.ts')
  assert.match(turn, /const nowStr = localStampTz\(now\)/)
  assert.ok(
    !/function localHHmm/.test(turn),
    'turn.ts must import localHHmm, not keep its own copy — that divergence is the whole bug',
  )
})
