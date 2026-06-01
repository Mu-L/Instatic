/**
 * AdminWorkspaceCanvasLayout — canvas shell for non-site workspaces.
 *
 * Content, Data, and Media use the same full-height canvas chrome as the Site
 * editor, but they do not need Site-editor-only modules: CanvasRoot,
 * PropertiesPanel, DnD, import wizards, or CodeMirror. Keeping this layout
 * separate lets those workspaces render their own canvas/sidebar content
 * without downloading the page-builder graph on first paint.
 */

import { lazy, Suspense, useRef, type CSSProperties, type ReactNode } from 'react'
import { Toolbar } from '@site/toolbar/Toolbar'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import { useEditorSelectPreference } from '@site/preferences/editorPreferences'
import { useEditorLayoutPersistence } from '@site/hooks/useEditorLayoutPersistence'
import { useEditorStore } from '@site/store/store'
import { useInstalledEditorPlugins } from '@admin/pages/plugins/hooks/useInstalledEditorPlugins'
import { usePluginEventBridge } from '@admin/pages/plugins/hooks/usePluginEventBridge'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { useAdminUi } from '@admin/state/adminUi'
import { useSiteSummary } from '@admin/state/useSiteSummary'
import { cn } from '@ui/cn'
import type { AdminWorkspace } from '@admin/workspace'
import styles from '../AdminCanvasLayout/AdminCanvasLayout.module.css'
import rightSidebarStyles from '@site/sidebars/RightSidebar/RightSidebar.module.css'

const SettingsModal = lazy(() =>
  import('@admin/modals/Settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
)

type WorkspaceCanvasSection = Extract<AdminWorkspace, 'content' | 'data' | 'media'>

interface AdminWorkspaceCanvasLayoutProps {
  workspace: WorkspaceCanvasSection
  contentSidebar?: ReactNode
  contentCanvas?: ReactNode
  contentRightPanel?: ReactNode
  toolbarRightSlot?: ReactNode
}

export function AdminWorkspaceCanvasLayout({
  workspace,
  contentSidebar,
  contentCanvas,
  contentRightPanel,
  toolbarRightSlot,
}: AdminWorkspaceCanvasLayoutProps) {
  useSiteSummary()
  useEditorLayoutPersistence(workspace)
  useInstalledEditorPlugins()
  usePluginEventBridge()

  const currentUser = useCurrentAdminUser()
  const density = useEditorSelectPreference('density')
  const adminUiSiteName = useAdminUi((s) => s.siteName)
  const adminUiFaviconUrl = useAdminUi((s) => s.siteFaviconUrl)
  const editorSiteName = useEditorStore((s) => s.site?.name ?? null)
  const editorFaviconUrl = useEditorStore((s) => s.site?.settings.faviconUrl ?? null)
  const siteName = editorSiteName ?? adminUiSiteName
  const faviconUrl = editorSiteName !== null ? editorFaviconUrl : adminUiFaviconUrl
  const settingsOpen = useAdminUi((s) => s.settingsOpen)
  const propertiesPanelCollapsed = useEditorStore((s) => s.propertiesPanel.collapsed)
  const hasRightSidebar = workspace !== 'media' && !propertiesPanelCollapsed

  return (
    <div className={styles.shell} data-editor-density={density}>
      <Toolbar
        siteName={siteName}
        faviconUrl={faviconUrl}
        section={workspace}
        adminNavigationSlot={(
          <AdminSectionNavigation
            section={workspace}
            currentUser={currentUser}
          />
        )}
        rightSlot={toolbarRightSlot}
      />

      <ConfirmDeleteProvider>
        <div className={styles.editorBody}>
          {contentSidebar ?? null}
          <div
            className={cn(styles.canvasStage, hasRightSidebar && styles.canvasStageRightSidebarOpen)}
            data-right-sidebar-expanded={hasRightSidebar ? 'true' : 'false'}
          >
            <div className={styles.canvasContent} key={workspace}>
              {contentCanvas}
            </div>
          </div>
          <WorkspaceRightSidebar
            hidden={workspace === 'media'}
            contentPanel={contentRightPanel}
          />
        </div>
      </ConfirmDeleteProvider>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
    </div>
  )
}

interface WorkspaceRightSidebarProps {
  hidden: boolean
  contentPanel?: ReactNode
}

function WorkspaceRightSidebar({ hidden, contentPanel }: WorkspaceRightSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const propertiesPanel = useEditorStore((s) => s.propertiesPanel)
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)
  const isExpanded = !hidden && !propertiesPanel.collapsed
  const panelWidth = isExpanded ? propertiesPanel.width : 0
  const style = {
    '--right-sidebar-panel-width': `${panelWidth}px`,
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={rightSidebarStyles.sidebar}
      data-testid="right-sidebar"
      data-expanded={isExpanded ? 'true' : 'false'}
      data-mode="workspace"
      style={style}
    >
      {isExpanded && (
        <SidebarResizeHandle
          side="right"
          width={propertiesPanel.width}
          targetRef={sidebarRef}
          cssVariable="--right-sidebar-panel-width"
          ariaLabel="Resize right sidebar"
          onResize={(width) => setPropertiesPanel({ width })}
        />
      )}

      {isExpanded && contentPanel && (
        <div
          className={rightSidebarStyles.panelSlot}
          data-testid="right-sidebar-panel-slot"
        >
          {contentPanel}
        </div>
      )}
    </aside>
  )
}
