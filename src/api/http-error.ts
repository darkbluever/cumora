/**
 * The error `http()` throws, and the one question its callers need answered:
 * did the SERVER say something authoritative, or did we simply fail to ask?
 *
 * `http()` used to throw a bare `Error` with the status baked into the message
 * string. Two independent call sites needed the status back out of it and could
 * not get it — `AuthGate`'s /auth/me probe (a 401 means log out; a failed fetch
 * does not) and `stores/messages`' send retry (a 4xx means the send is dead; a
 * 5xx means try again). Carrying the status on the error is what makes both
 * distinctions possible.
 *
 * This lives outside client.ts so it can be unit-tested without pulling in the
 * renderer's module graph (zustand store, `@/` aliases, DOM). client.ts
 * re-exports it, so `import { ApiError } from '@/api/client'` keeps working.
 */

/** A response came back, and it was not ok. `status` is the server's, verbatim. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Did the server authoritatively reject the caller's session?
 *
 *  TRUE for exactly one thing: an HTTP 401. Every route reaches `requireAuth`,
 *  which throws 401 for a session that is missing, expired, or suspended — so
 *  401 already covers every genuine "you are logged out" case, and nothing else
 *  needs to.
 *
 *  FALSE for everything else, including a rejected fetch (api down, wifi gone),
 *  a 5xx, a proxy error, and any error we don't recognize. Those mean "cannot
 *  verify right now", which is not grounds to destroy a session: the cost of
 *  keeping a token that turns out to be dead is one more failed probe, while
 *  the cost of dropping a live one is a full re-authentication.
 *
 *  The status is read off the error object, never matched out of its text — a
 *  server message that merely mentions 401 must not be able to log anyone out. */
export function isSessionRejection(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401
}
