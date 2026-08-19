/**
 * AuthGate — wraps the entire app and decides whether to show the
 * sign-in screen or the real UI based on the auth store.
 *
 * Two responsibilities:
 *   1. On first mount, consume a `#token=...&companyId=...` fragment if
 *      one is present (the OAuth callback redirected us back with it).
 *      Persist the session, then scrub the URL so a reload doesn't
 *      re-arm the fragment.
 *   2. Probe /auth/me with the persisted token; if the token is valid
 *      the app loads. Only a 401 — the server actually rejecting it —
 *      routes to AuthScreen. A failure we cannot judge (api restarting,
 *      offline, 5xx) keeps the token and re-probes: see PROBE_RETRY_MS.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api, isSessionRejection } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { isElectron } from '@/lib/runtime'
import { AuthScreen } from './AuthScreen'
import { WindowDragStrip } from './WindowDragStrip'

interface AuthGateProps {
  children: ReactNode
  /** Override the "no token" rendering. The invite-accept flow uses this
   *  so an unauthenticated visitor sees the invitation card (with sign-in
   *  buttons embedded) instead of the bare login screen. */
  unauthFallback?: ReactNode
}

interface CarriedSession { token: string; companyId: string | null }

/** Backoff for re-probing /auth/me after a failure that says nothing about the
 *  token. The first delay is deliberately shorter than an api restart so the
 *  common case (dev server reloading, a deploy rolling) is invisible; the last
 *  one repeats indefinitely so a long outage doesn't hammer a dead server —
 *  and so the app recovers on its own the moment it comes back. */
const PROBE_RETRY_MS = [400, 900, 2000, 4000, 8000] as const

/** Pull a fresh OAuth token out of `location.hash`. Returns null if the
 *  fragment is empty or has no token. On success, scrubs the fragment so
 *  the token never lingers in the browser address bar. */
function consumeOAuthFragment(): CarriedSession | null {
  const hash = location.hash.replace(/^#/, '')
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const token = params.get('token')
  if (!token) return null
  const companyId = params.get('companyId')
  // Replace the URL without ?#... so refresh/reopen doesn't re-process.
  history.replaceState(null, '', location.pathname + location.search)
  return { token, companyId }
}


export function AuthGate({ children, unauthFallback }: AuthGateProps) {
  const token = useAuth((s) => s.token)
  const ready = useAuth((s) => s.ready)
  const setSession = useAuth((s) => s.setSession)
  const setMe = useAuth((s) => s.setMe)
  const setServerCapabilities = useAuth((s) => s.setServerCapabilities)
  const clear = useAuth((s) => s.clear)
  const markReady = useAuth((s) => s.markReady)

  /** The probe has failed enough times that it is worth saying so. NOT a
   *  logged-out state — the token is still here and still being retried. */
  const [unreachable, setUnreachable] = useState(false)

  // Run-once: consume the OAuth fragment before the probe effect sees
  // `token` and decides what to do. useState init runs synchronously
  // before any effect, so the auth store has the new token in time.
  useState(() => {
    const carried = consumeOAuthFragment()
    if (carried) {
      // setMe runs on the /auth/me probe right below. For now just plant
      // a placeholder user so setSession's WS-reconnect call has a valid
      // token; the probe will fill in the rest.
      setSession(carried.token, { id: '', email: '', name: '' }, carried.companyId)
    }
    return null
  })

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!token) { markReady(); return }
    let attempt = 0
    const probe = () => {
      void (async () => {
        try {
          const r = await api.authMe()
          if (cancelled) return
          setUnreachable(false)
          setMe(r.user, r.companies, r.activeCompanyId)
          setServerCapabilities(r.serverCapabilities)
          markReady()
        } catch (err) {
          if (cancelled) return
          // A 401 is the server SAYING this token is dead. That — and only
          // that — is grounds to delete the session and go to login.
          if (isSessionRejection(err)) {
            clear()
            return
          }
          // Anything else (fetch rejected, 5xx, proxy error) means we never
          // got an answer about the token. Clearing here is what used to log
          // users out every time the api restarted; keep it and ask again.
          const delay = PROBE_RETRY_MS[Math.min(attempt, PROBE_RETRY_MS.length - 1)]
          attempt += 1
          // Stay on the loading flash for the first few tries, then say what's
          // actually wrong instead of spinning silently forever.
          if (attempt >= PROBE_RETRY_MS.length) setUnreachable(true)
          timer = setTimeout(probe, delay)
        }
      })()
    }
    probe()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [token, setMe, setServerCapabilities, clear, markReady])

  // Electron-only: listen for OAuth tokens forwarded by the main
  // process. The user clicked "Continue with Google" → we opened the
  // system browser → provider redirected through our server to
  // http://127.0.0.1:47823/auth/done → loopback page POSTed the
  // parsed fragment to /auth/token → main IPC'd here. Plant the
  // session and trip the /auth/me probe by setting token.
  useEffect(() => {
    if (!isElectron || !window.cumora?.auth) return
    const off = window.cumora.auth.onToken(({ token: t, companyId }) => {
      if (!t) return
      setSession(t, { id: '', email: '', name: '' }, companyId)
    })
    return off
  }, [setSession])

  // Native (iOS / Android): when the SFSafariViewController flow
  // completes, lib/native.ts plants the token fragment on our location
  // and fires `cumora:oauth-token`. Consume it the same way as the
  // top-of-mount `consumeOAuthFragment` so AuthGate's existing probe
  // logic picks up the new token.
  useEffect(() => {
    const handler = () => {
      const carried = consumeOAuthFragment()
      if (!carried) return
      setSession(carried.token, { id: '', email: '', name: '' }, carried.companyId)
    }
    window.addEventListener('cumora:oauth-token', handler)
    return () => window.removeEventListener('cumora:oauth-token', handler)
  }, [setSession])

  if (!ready) {
    // Can't reach the server. Say so rather than spinning forever — and do NOT
    // fall through to AuthScreen: the session is intact, the server is just not
    // answering, and the retry loop above recovers on its own.
    if (unreachable) {
      return (
        <div
          className="fixed inset-0 grid place-items-center px-8 text-center text-ink-300 font-display italic text-[13px]"
          style={{ background: 'var(--paper)' }}
        >
          <WindowDragStrip />
          <div>
            can't reach the server
            <div className="mt-1 not-italic text-[11px] text-ink-200">still signed in · retrying…</div>
          </div>
        </div>
      )
    }
    // Brief loading flash while we probe — keeps the app from flashing
    // login → main on a valid token reload.
    return (
      <div
        className="fixed inset-0 grid place-items-center text-ink-300 font-display italic text-[13px]"
        style={{ background: 'var(--paper)' }}
      ><WindowDragStrip />loading…</div>
    )
  }

  if (!token) return <>{unauthFallback ?? <AuthScreen />}</>
  return <>{children}</>
}
