/**
 * Regression: every place we parse a MODEL's JSON answer must tolerate the
 * model's own packaging.
 *
 * Observed live, repeating every ~3s per agent in the api log:
 *
 *     [agenda] classifier failed Unexpected token '`', "```json
 *     {"... is not valid JSON
 *
 * Five call sites ask for `text: { format: { type: 'json_object' } }` and then
 * `JSON.parse(r.output_text)` bare. `json_object` is a CLOUD guarantee; behind
 * an OpenAI-compatible shim (this machine talks to a local gateway) it is not
 * honored, so the model answers in a ```json fence and every one of those five
 * parses throws. Each site has a catch, so nothing crashes — it silently
 * degrades:
 *
 * - `agenda.ts` — loudest. Every heartbeat pays for the LLM call, throws, and
 *   lands in the deterministic fallback, so the classifier that exists to keep
 *   wakes off the big brain never actually got to vote.
 * - `inbox-triage.ts` synthetic-wake gate — fails CLOSED, silently starving
 *   the wake it was asked about.
 * - `convene.ts` — a reached decision is read as "no decision".
 * - `tools.ts` palette — returns zero colors, `ok: false`.
 * - `api/router.ts` avatar gender — falls back to a name hash.
 *
 * `triage-core.ts` already solved exactly this (its `extractJsonObject`, and
 * `parseTriage: tolerates ```json fences …` in triage-core.test.ts) — the
 * helper was just private to that one module. This file pins the shared
 * version and pins that all six sites go through it, so the next model behind
 * a shim doesn't reopen the same five holes one at a time.
 *
 * Run: node --import tsx --test server/src/__tests__/llm-json.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractJsonObject } from '../agents/llm-json.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const parse = (raw: string): unknown => JSON.parse(extractJsonObject(raw))

test('THE regression: a ```json fence parses instead of throwing', () => {
  // Byte-for-byte the shape the api log reported.
  const raw = '```json\n{"actionable": false, "focus": "", "reason": "nothing due"}\n```'
  assert.deepEqual(parse(raw), { actionable: false, focus: '', reason: 'nothing due' })
})

test('a bare ``` fence with no language tag parses too', () => {
  assert.deepEqual(parse('```\n{"gender":"feminine"}\n```'), { gender: 'feminine' })
})

test('a clean JSON object is passed through untouched', () => {
  assert.deepEqual(parse('{"colors":["#aabbcc"]}'), { colors: ['#aabbcc'] })
})

test('chatter before and after the object is dropped', () => {
  const raw = 'Here is my verdict:\n{"reached": true, "headline": "ship it"}\nHope that helps!'
  assert.deepEqual(parse(raw), { reached: true, headline: 'ship it' })
})

test('a nested object keeps its outer closing brace', () => {
  // lastIndexOf('}') and not indexOf, or the object truncates mid-nesting.
  assert.deepEqual(parse('sure:\n{"a":{"b":1},"c":2}\ndone'), { a: { b: 1 }, c: 2 })
})

test('an opening fence with no closing fence still parses', () => {
  // max_output_tokens cuts the model off mid-answer; the object itself
  // completed but the trailing fence never arrived.
  assert.deepEqual(parse('```json\n{"act": true, "reason": "human waiting"}'), {
    act: true,
    reason: 'human waiting',
  })
})

test('leading whitespace and \\r\\n do not defeat the fence', () => {
  assert.deepEqual(parse('\r\n```json\r\n{"actionable": true}\r\n```\r\n'), { actionable: true })
})

test('prose with no object at all stays unparseable — callers must keep failing closed', () => {
  // This helper recovers PACKAGING, it does not invent a verdict. Every call
  // site treats a throw as "classifier unavailable" and degrades on purpose;
  // returning `{}` here would silently turn an outage into a real answer.
  assert.throws(() => parse('Sorry, I cannot help with that.'))
  assert.throws(() => parse(''))
  // Control, so a helper that returned '' for everything could not pass this:
  assert.doesNotThrow(() => parse('```json\n{"actionable": false}\n```'))
})

// ─── Wiring ──────────────────────────────────────────────────────────────────
// Source assertions: reaching these parses for real means a live LLM client at
// five different call sites. The helper being correct is worth nothing while a
// site still hands `output_text` straight to JSON.parse.

const SITES = [
  'agents/agenda.ts',
  'agents/inbox-triage.ts',
  'agents/convene.ts',
  'agents/tools.ts',
  'api/router.ts',
]

for (const rel of SITES) {
  test(`${rel} parses model JSON through the shared helper`, () => {
    const src = read(rel)
    assert.ok(
      !/JSON\.parse\(\s*(?:r|res|resp)\.output_text/.test(src),
      `${rel} still hands output_text straight to JSON.parse — a fenced answer throws`,
    )
    assert.ok(
      !/JSON\.parse\(\s*text\s*\)/.test(src),
      `${rel} still parses the raw output_text text variable`,
    )
    assert.match(src, /extractJsonObject\(/, `${rel} must route the model's answer through the helper`)
  })
}

test('triage-core keeps no private copy of the extractor', () => {
  const src = read('agents/triage-core.ts')
  assert.ok(
    !/function extractJsonObject/.test(src),
    'triage-core.ts must import the shared extractor, not keep the copy this module was lifted from',
  )
  assert.match(src, /from '\.\/llm-json\.js'/)
})
