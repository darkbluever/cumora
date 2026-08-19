/**
 * Regression: a BYOA runtime call must never be pinned to one token string.
 *
 * The bug this pins: `daemon.ts` resolved the runtime JWT ONCE at the start of a
 * turn (`const token = this.token`) and reused that string for every `/typing`,
 * `/status`, `/thinking/mark`, `/runs/<id>/heartbeat` and `/runs/<id>/finish`
 * for the whole turn. The token's TTL is 2h (AGENT_TOKEN_TTL_SECONDS in
 * registry.ts); BYOA turns legitimately run longer than that. Once the captured
 * string expired, EVERY one of those calls 401ed, `runtimeBest` swallowed the
 * 401 as `null`, so the run's `updated_at` froze — and the server's 10-minute
 * stale-run sweeper (observability.ts markStaleAgentRuns) reaped a perfectly
 * healthy, still-producing turn as `failed / stage='orphaned'`.
 *
 * Two properties make that impossible now, and this file asserts both:
 *  1. auth is resolved PER REQUEST (`TokenSource.get()`), so a refresh that
 *     happens mid-turn is picked up by the next call;
 *  2. a 401 invalidates the cached token and the request is retried ONCE with a
 *     freshly minted one — so mid-turn expiry (or a server restart with a
 *     different AGENT_RUNTIME_SECRET) self-heals instead of silently starving
 *     the heartbeat until the run is reaped.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-runtime-token-refresh.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runtimeFetch, type TokenSource } from '../agents/computer/daemon.js'

const SAVED_FETCH = globalThis.fetch

/** A TokenSource that mints a new, distinct token on every (re-)mint. */
function fakeTokens(): TokenSource & { mints: number; current: string } {
  let n = 0
  let cached = ''
  const src = {
    get mints() { return n },
    get current() { return cached },
    async get(): Promise<string> {
      if (!cached) cached = `tok-${++n}`
      return cached
    },
    invalidate(): void { cached = '' },
  }
  return src as TokenSource & { mints: number; current: string }
}

/** Record every Authorization header the daemon actually put on the wire. */
let sent: string[] = []

beforeEach(() => { sent = [] })
afterEach(() => { globalThis.fetch = SAVED_FETCH })

function stubFetch(statuses: number[]): void {
  let i = 0
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    sent.push(headers.Authorization ?? '')
    const status = statuses[Math.min(i++, statuses.length - 1)]
    return new Response(status === 200 ? '{}' : 'unauthorized', { status })
  }) as typeof fetch
}

test('a 200 needs exactly one mint and one request', async () => {
  stubFetch([200])
  const tokens = fakeTokens()
  const res = await runtimeFetch('http://srv', '/runs/r1/heartbeat', tokens, { method: 'POST' })
  assert.equal(res?.status, 200)
  assert.deepEqual(sent, ['Bearer tok-1'])
})

test('a 401 re-mints and retries ONCE with the NEW token', async () => {
  // First attempt 401s (the expired-mid-turn case), the retry succeeds.
  stubFetch([401, 200])
  const tokens = fakeTokens()
  const res = await runtimeFetch('http://srv', '/runs/r1/heartbeat', tokens, { method: 'POST' })
  assert.equal(res?.status, 200, 'the retry must be the value the caller sees')
  assert.deepEqual(
    sent,
    ['Bearer tok-1', 'Bearer tok-2'],
    'the retry must carry a FRESHLY MINTED token — retrying with the same ' +
      'expired string is what let the heartbeat 401 forever and the sweeper reap the run',
  )
})

test('a persistent 401 gives up after the single retry (no infinite mint loop)', async () => {
  stubFetch([401])
  const tokens = fakeTokens()
  const res = await runtimeFetch('http://srv', '/status', tokens, { method: 'POST' })
  assert.equal(res, null, 'unauthenticated after a re-mint → null, so callers degrade quietly')
  assert.equal(sent.length, 2, 'exactly two attempts — a hard 401 must not spin')
})

test('auth is resolved per request, so a mid-turn refresh is picked up', async () => {
  stubFetch([200])
  const tokens = fakeTokens()
  await runtimeFetch('http://srv', '/typing', tokens, { method: 'POST' })
  // Simulate the token expiring / being refreshed between two calls of the SAME turn.
  tokens.invalidate()
  await runtimeFetch('http://srv', '/typing', tokens, { method: 'POST' })
  assert.deepEqual(
    sent,
    ['Bearer tok-1', 'Bearer tok-2'],
    'the second call must re-resolve auth, not reuse a string captured at turn start',
  )
})

test('the caller-supplied headers survive alongside the injected Authorization', async () => {
  stubFetch([200])
  const tokens = fakeTokens()
  let seen: Record<string, string> = {}
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = (init?.headers ?? {}) as Record<string, string>
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  await runtimeFetch('http://srv', '/llm-calls', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(seen['Content-Type'], 'application/json')
  assert.equal(seen.Authorization, 'Bearer tok-1')
})
