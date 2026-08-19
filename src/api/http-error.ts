/**
 * The error `http()` throws, and the one question its callers need answered:
 * did the SERVER say this token is bad, or did we simply fail to ask?
 *
 * `http()` used to throw a bare `Error` with the status baked into the message
 * string. That left `AuthGate`'s /auth/me probe unable to tell a real 401 from
 * a fetch that never reached anything, so it treated every failure as "token
 * expired" and deleted the session — logging the user out whenever the api
 * happened to be restarting. Carrying the status on the error is what makes
 * the distinction possible at all.
 */

/** A response came back, and it was not ok. `status` is the server's, verbatim.
 *  `message` reproduces the string `http()` has always thrown, because the UI
 *  renders it in toasts and inline errors. */
export class HttpError extends Error {
  readonly status: number
  /** The server's own error text when it sent one (`{error: "..."}`), else null. */
  readonly detail: string | null

  constructor(status: number, statusText: string, detail: string | null) {
    super(detail ? `${detail} (${status})` : `${status} ${statusText}`)
    this.name = 'HttpError'
    this.status = status
    this.detail = detail
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
  return err instanceof HttpError && err.status === 401
}
