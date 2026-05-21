import type { SiteDocument } from '@core/page-tree'

/**
 * IPersistenceAdapter — the interface the CMS draft storage backend satisfies.
 */
export interface IPersistenceAdapter {
  /** Persist the single site draft document (shell + pages). */
  saveSite(site: SiteDocument): Promise<void>

  /**
   * Load the single site draft document (shell + pages assembled).
   * Returns undefined before setup creates it.
   */
  loadSite(id: string): Promise<SiteDocument | undefined>
}
