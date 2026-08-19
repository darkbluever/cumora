/**
 * Regression: a network failure must NOT log the user out.
 *
 * `AuthGate` probes /auth/me on mount to decide login-screen vs app. Its catch
 * was unconditional:
 *
 *     } catch {
 *       // Token's bad / expired — clear and route to login.
 *       if (!cancelled) clear()
 *     }
 *
 * The comment names one cause; the code catches ALL of them. `clear()` deletes
 * `cumora.auth.token` from localStorage and sets `ready: true`, so ANY failure
 * — fetch rejecting because the api is mid-restart, a 500, a proxy hiccup, a
 * dropped wifi frame — permanently destroys a session that the server never
 * said anything bad about. The user is dropped on the login screen and has to
 * re-run OAuth for a two-second outage.
 *
 * Observed on this machine: the api runs under `tsx watch`, so every server-file
 * save restarts it (24 times in one afternoon), and web.log carries the matching
 *
 *     [vite] http proxy error: /api/auth/ws-ticket AggregateError [ECONNREFUSED]
 *
 * A reload landing inside one of those windows logs you out. Nothing on the
 * server side can cause this: sessions are Postgres rows with a 30-day TTL and
 * `resolveSession()` only DELETEs on expiry, so an api restart cannot
 * invalidate anyone.
 *
 * The fix is the distinction the original code collapsed: only the SERVER
 * saying 401 is a verdict on the token. Everything else means "cannot verify
 * right now" — keep the token and retry.
 *
 * Run: node --import tsx --test server/src/__tests__/auth-probe-network-error.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HttpError, isSessionRejection } from '../../../src/api/http-error.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

test('HttpError carries the status the server actually sent', () => {
  const err = new HttpError(503, 'Service Unavailable', null)
  assert.equal(err.status, 503)
  assert.ok(err instanceof Error, 'every existing `catch (e)` site treats this as an Error')
})

test('HttpError keeps the message shape callers already render', () => {
  // The UI surfaces `err.message` in toasts and inline errors. Preserve both
  // branches of the old formatting exactly, or every error string in the app
  // changes as a side effect of this fix.
  assert.equal(new HttpError(404, 'Not Found', 'board not found').message, 'board not found (404)')
  assert.equal(new HttpError(404, 'Not Found', null).message, '404 Not Found')
})

test('a 401 IS the server rejecting the token', () => {
  // The only clear-worthy answer. /auth/me reaches `requireAuth`, which throws
  // 401 for a missing, expired, or suspended session — so 401 covers every
  // real "you are logged out" case.
  assert.equal(isSessionRejection(new HttpError(401, 'Unauthorized', 'authentication required')), true)
})

// Every "must be false" case below carries the 401 control in the same test.
// Without it a predicate that just returns false passes them all vacuously —
// and "returns false" is exactly the shape a stub or a broken guard has.
const CONTROL = new HttpError(401, 'Unauthorized', 'authentication required')

test('THE regression: a rejected fetch is not a verdict on the token', () => {
  // What the browser throws when the api is not listening. No status at all —
  // the server never got the chance to judge the token.
  assert.equal(isSessionRejection(new TypeError('Failed to fetch')), false)
  assert.equal(isSessionRejection(new TypeError('NetworkError when attempting to fetch resource.')), false)
  assert.equal(isSessionRejection(CONTROL), true, 'control: the predicate must still say yes to a real 401')
})

test('a 5xx is not a verdict on the token', () => {
  // Vite's default proxy error handler answers 500 on ECONNREFUSED rather than
  // rejecting the fetch, so this is the shape the dev setup actually produces.
  for (const status of [500, 502, 503, 504]) {
    assert.equal(
      isSessionRejection(new HttpError(status, 'boom', 'upstream died')),
      false,
      `${status} means the server is broken, not that the session is`,
    )
  }
  assert.equal(isSessionRejection(CONTROL), true, 'control')
})

test('a 403 is not a verdict on the token either', () => {
  // /auth/me never 403s for session reasons — requireAuth throws 401. A 403
  // would be an authorization answer about a RESOURCE, which is not grounds to
  // delete a valid session.
  assert.equal(isSessionRejection(new HttpError(403, 'Forbidden', 'not a member')), false)
  assert.equal(isSessionRejection(CONTROL), true, 'control')
})

test('the status is read from the error, never matched out of its text', () => {
  // A plain Error whose message happens to contain 401 must not trip this;
  // string-matching would make an unrelated server message able to log a user
  // out, which is the same defect one level down.
  assert.equal(isSessionRejection(new Error('upstream returned 401 for its own dependency')), false)
  assert.equal(isSessionRejection(new Error('unauthorized (401)')), false)
  // Control, so the two above cannot pass by the predicate simply always
  // returning false.
  assert.equal(isSessionRejection(new HttpError(401, 'Unauthorized', null)), true)
})

test('an unrecognizable failure keeps the session', () => {
  // Fail SAFE: the cost of keeping a dead token is one more failed probe; the
  // cost of dropping a live one is a full re-auth.
  for (const junk of [null, undefined, 'nope', 0, {}, { status: 401 }]) {
    assert.equal(isSessionRejection(junk), false, `${JSON.stringify(junk) ?? String(junk)} proves nothing`)
  }
  assert.equal(isSessionRejection(CONTROL), true, 'control')
})

test('http() throws the typed error, so the status survives to the caller', () => {
  const client = read('src/api/client.ts')
  assert.match(client, /throw new HttpError\(/, 'http() must throw the typed error')
  assert.ok(
    !/throw new Error\(detail \?/.test(client),
    'the old untyped throw discards the status — that is what forced AuthGate to guess',
  )
})

test('AuthGate clears the session ONLY on an authoritative rejection', () => {
  const gate = read('src/components/AuthGate.tsx')
  // The bug was a bare `catch {`: the error was not even bound, so no decision
  // was possible. Binding it is the precondition for every assertion below.
  assert.ok(
    !/\}\s*catch\s*\{/.test(gate),
    'the probe must inspect the failure, not swallow it',
  )
  assert.match(
    gate,
    /if \(isSessionRejection\(err\)\) \{\s*clear\(\)/,
    'clear() must sit in the guarded branch',
  )
  // ...and NOWHERE else, or the guard is decoration.
  const clears = gate.match(/\bclear\(\)/g) ?? []
  assert.equal(clears.length, 1, `clear() must have exactly one call site, found ${clears.length}`)
})

test('AuthGate retries an unverifiable probe instead of giving up', () => {
  const gate = read('src/components/AuthGate.tsx')
  assert.match(gate, /setTimeout/, 'a failure it cannot judge must be re-probed')
  // markReady() on an unverifiable failure would render the app with token set
  // but user null — every `useMe()` consumer reads null and the shell breaks in
  // a way that looks nothing like the actual problem (the api being down).
  assert.ok(
    !/if \(isSessionRejection\(err\)\) \{[\s\S]*?\}\s*markReady\(\)/.test(gate),
    'do not mark the app ready on a probe that never succeeded',
  )
})
