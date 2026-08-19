/**
 * One wall clock for everything an agent reads.
 *
 * The wake prompt (`turn.ts`) renders "now" and every message timestamp in the
 * server's LOCAL timezone, because rendering UTC made agents disagree about
 * what time it was. The agent CLI printed `toISOString()` — bare UTC, no
 * marker — so the same instant read 8 hours apart on a +08:00 host depending on
 * which surface the agent happened to look at.
 *
 * Both sides now format through here. Nothing in this module knows the offset:
 * it delegates to the platform's local getters, so the host's timezone (macOS
 * `Asia/Shanghai`, a container's `Etc/UTC`) is the single source of truth and
 * there is no Cumora-level timezone setting to keep in sync.
 *
 * Storage is unaffected — every column is `timestamptz`, i.e. an absolute
 * instant. This is display and input parsing only.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

const asDate = (d: Date | string): Date => (typeof d === 'string' ? new Date(d) : d)

/** The IANA zone the process actually resolved (e.g. `Asia/Shanghai`). */
export function localTzName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** `HH:mm` in local time — the compact form used inside rendered threads. */
export function localHHmm(d: Date | string): string {
  const date = asDate(d)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `YYYY-MM-DD HH:mm` in local time. No `T`, no `Z`: a bare stamp must never
 *  look like an ISO instant, or an agent will read it as UTC. */
export function localStamp(d: Date | string): string {
  const date = asDate(d)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${localHHmm(date)}`
}

/** `localStamp` plus the zone name. Use wherever a timestamp is the POINT of
 *  the line (schedules, alarms, mute expiry) so the agent can't misread it. */
export function localStampTz(d: Date | string): string {
  return `${localStamp(d)} (${localTzName()})`
}

/**
 * Parse an agent-supplied timestamp, resolving ambiguity toward LOCAL time.
 *
 * JS parsing is inconsistent in exactly the way that bites here: a date-ONLY
 * string is UTC midnight per spec, while a date-TIME string without an offset
 * is local. So `--at 2026-08-20` and `--at 2026-08-20T00:00` used to mean two
 * different instants. An agent writing a bare date means the start of ITS day.
 *
 * An explicit offset (`Z`, `+05:30`) is always honored — if the agent said
 * UTC, it meant UTC. Returns null rather than an Invalid Date so callers can
 * report the bad input instead of storing NaN.
 */
export function parseLocalTimestamp(raw: string): Date | null {
  const text = raw.trim()
  if (!text) return null
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    // Local midnight, via the local-args constructor.
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
  }
  // `YYYY-MM-DD HH:mm` is not an ISO form; normalize the separator so V8 takes
  // the offset-less date-time path (which is local) rather than falling back to
  // its implementation-defined parser.
  const normalized = text.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
