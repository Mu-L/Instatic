import { useEffect, useState } from 'react'
import {
  getCmsPublicSite,
  getCmsSetupStatus,
  getCurrentCmsUser,
  type CmsCurrentUser,
  type CmsPublicSite,
} from '@core/persistence'

// Phase the admin shell can be in after the boot effect has resolved. The
// 'mfa' phase is owned by the pre-auth form (it's a sub-state of 'login' that
// only the login submit handler can enter), so it never appears here — the
// bootstrap can only land us in setup / login / editor.
export type AdminBootPhase = 'setup' | 'login' | 'editor'

export interface AdminBootResult {
  status: 'loading' | 'ready'
  phase: AdminBootPhase
  currentUser: CmsCurrentUser | null
  publicSite: CmsPublicSite
  initialError: string | null
}

const DEFAULT_PUBLIC_SITE: CmsPublicSite = { name: null, faviconUrl: null }

/**
 * Resolves the initial admin shell state on mount:
 *  1. Site identity (logo + name) is fetched in parallel so the brand row
 *     can hydrate independently of the auth probe.
 *  2. Setup status decides whether the install needs first-run setup.
 *  3. If setup is complete, the current-user probe decides login vs. editor.
 *
 * The hook never re-runs — once 'ready', subsequent transitions (login
 * success, MFA verify, logout) are owned by the pre-auth form / authenticated
 * shell, not this hook.
 */
export function useAdminBoot(): AdminBootResult {
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')
  const [phase, setPhase] = useState<AdminBootPhase>('login')
  const [currentUser, setCurrentUser] = useState<CmsCurrentUser | null>(null)
  const [publicSite, setPublicSite] = useState<CmsPublicSite>(DEFAULT_PUBLIC_SITE)
  const [initialError, setInitialError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    // Site identity hydrates independently of the auth probe so a slow
    // identity endpoint never blocks login.
    void getCmsPublicSite()
      .then((next) => {
        if (!cancelled) setPublicSite(next)
      })
      .catch(() => {
        // Brand row falls back to the default mark on failure.
      })

    async function resolveAuthPhase(): Promise<void> {
      try {
        // Fire both probes in parallel. setup/status decides which UI to
        // show; /me decides whether we have a session. The two answers
        // don't depend on each other, so sequential awaits wasted one
        // round-trip on every cold load. We swallow /me's rejection up
        // front so the speculative request can't crash the boot if the
        // server bounces /me before setup/status resolves.
        const setupStatusPromise = getCmsSetupStatus()
        const currentUserPromise = getCurrentCmsUser().then(
          (u) => ({ ok: true as const, user: u }),
          () => ({ ok: false as const }),
        )
        const setupStatus = await setupStatusPromise
        if (cancelled) return

        if (setupStatus.needsSetup) {
          setPhase('setup')
          setStatus('ready')
          // Drain the speculative /me request so we don't leak a pending
          // promise rejection.
          void currentUserPromise
          return
        }

        const currentUserResult = await currentUserPromise
        if (cancelled) return
        if (currentUserResult.ok) {
          setCurrentUser(currentUserResult.user)
          setPhase('editor')
        } else {
          setCurrentUser(null)
          setPhase('login')
        }
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setInitialError(err instanceof Error ? err.message : 'CMS is unavailable')
        setPhase('login')
        setStatus('ready')
      }
    }

    void resolveAuthPhase()
    return () => { cancelled = true }
  }, [])

  return { status, phase, currentUser, publicSite, initialError }
}
