/**
 * Admin layouts — pick one of these as the root of any admin page:
 *
 *   - AdminCanvasLayout: the visual Site editor shell. Carries floating
 *     editor panels, the page canvas, DnD wired to the SiteExplorer, and
 *     site sidebars. Heavy by design.
 *   - AdminWorkspaceCanvasLayout: the canvas shell for Content, Data, and
 *     Media. Reuses the full-height toolbar/sidebar/canvas chrome without
 *     importing Site-only canvas, panels, DnD, import wizards, or CodeMirror.
 *   - AdminPageLayout: the lightweight admin-page shell (Plugins, Users,
 *     Account, plugin admin pages). Toolbar + a centered, scrollable
 *     page body with a unified header (title, description, optional tabs
 *     and actions slots). NO editor-store dependency.
 *
 * IMPORTANT: import directly from the per-layout module (not this barrel)
 * so rolldown can split the two layouts into separate chunks. The barrel
 * defeats tree-shaking when both re-exports are reachable, which is what
 * makes the heavy AdminCanvasLayout graph leak into non-editor admin
 * pages.
 *
 *   import { AdminPageLayout }   from '@admin/layouts/AdminPageLayout'
 *   import { AdminCanvasLayout }          from '@admin/layouts/AdminCanvasLayout'
 *   import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout'
 *
 * This file intentionally exports nothing — keep deep imports the only
 * supported path.
 */
export {}
