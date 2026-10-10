'use client'

/**
 * Helpers this tab shares with the dashboard page that renders it.
 *
 * `page.tsx` owns `apiFetch`, `readJson`, `useAuth` and `ReadOnlyNotice`. The
 * notification tab is a separate module, and importing them from `page.tsx`
 * would be circular — `page.tsx` imports this tab.
 *
 * So page.tsx registers them here once at module scope, and this module reads
 * them. One direction of dependency, no circular import, and no threading five
 * bindings through WorkspacePage purely to satisfy module boundaries.
 *
 * `getSharedTabDeps` throws rather than returning undefined if a module is
 * loaded outside the dashboard — a missing helper should be an obvious failure
 * at first render, not `undefined is not a function` somewhere in a click
 * handler.
 */
export interface SharedTabDeps {
  apiFetch: (path: string, token: string | null, options?: RequestInit) => Promise<Response>
  readJson: (res: Response) => Promise<any>
  useAuth: () => { token: string | null }
  // The real useToast returns its state alongside `toast`; only `toast` is
  // needed here, and widening the declared type would hide the rest.
  useToast: () => ReturnType<typeof import('@/hooks/use-toast')['useToast']>
  ReadOnlyNotice: (props: { what: string }) => React.ReactElement
}

let registered: SharedTabDeps | null = null

/** Called by page.tsx at module scope. */
export function registerSharedTabDeps(deps: SharedTabDeps): void {
  registered = deps
}

export function getSharedTabDeps(): SharedTabDeps {
  if (!registered) {
    throw new Error(
      'Shared tab dependencies were never registered. Import page.tsx before rendering a split-out tab.',
    )
  }
  return registered
}