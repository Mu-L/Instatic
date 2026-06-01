/**
 * MediaPage — the dedicated Media workspace.
 *
 * Canvas-style admin shell through AdminWorkspaceCanvasLayout. Folder tree in
 * the left sidebar, file grid/list in the canvas. Every interactive overlay —
 * the asset viewer, the upload queue, the bulk-edit pane — is a floating
 * window (per design: no docked right rail on this page).
 *
 * Window visibility lives in local state here; `useDraggablePanel` only owns
 * each window's POSITION via `panelLayoutStorage`. The upload queue
 * auto-opens when something starts uploading; the bulk-edit window
 * auto-opens once the user has 2+ assets selected; the viewer opens whenever
 * the user has a primary selection.
 */
import { useEffect, useState } from 'react'
import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout'
import {
  readWorkspaceLayout,
  writeWorkspaceLayout,
} from '@site/layout/panelLayoutStorage'
import { Button } from '@ui/components/Button'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { MediaSidebar, type MediaSidebarPanelId } from './components/MediaSidebar/MediaSidebar'
import { MediaCanvas } from './components/MediaCanvas/MediaCanvas'
import { MediaViewerWindow } from './components/MediaViewerWindow/MediaViewerWindow'
import { UploadQueueWindow } from './components/UploadQueueWindow/UploadQueueWindow'
import { BulkEditWindow } from './components/BulkEditWindow/BulkEditWindow'
import { useMediaWorkspace } from './hooks/useMediaWorkspace'

const MEDIA_PANEL_IDS: ReadonlySet<MediaSidebarPanelId> = new Set(['folders', 'storage'])

function readPersistedMediaPanel(): MediaSidebarPanelId | null {
  const stored = readWorkspaceLayout('media').activeLeftPanel
  if (stored === null) return null
  if (typeof stored === 'string' && MEDIA_PANEL_IDS.has(stored as MediaSidebarPanelId)) {
    return stored as MediaSidebarPanelId
  }
  return 'folders'
}

export function MediaPage() {
  const workspace = useMediaWorkspace()
  // Initial value pulls from the per-workspace stored layout so the rail
  // remembers the last panel the user had open in the Media workspace.
  const [activePanel, setActivePanel] = useState<MediaSidebarPanelId | null>(
    readPersistedMediaPanel,
  )
  // Persist rail toggles so the next visit to /admin/media reopens the same
  // panel (or stays closed if the user closed it).
  useEffect(() => {
    writeWorkspaceLayout('media', { activeLeftPanel: activePanel })
  }, [activePanel])
  const [uploadQueueOpen, setUploadQueueOpen] = useState(false)
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)

  // Build the thin viewer-editor handle from the workspace. Same contract the
  // standalone MediaExplorerPanel-driven viewer uses, so the viewer doesn't
  // need to know it lives inside the full Media page.
  const viewerEditor = workspace.selectedAsset
    ? {
        asset: workspace.selectedAsset,
        tagPalette: workspace.tagPalette,
        folderById: workspace.folderById,
        updateAsset: workspace.updateAsset,
        renameAsset: workspace.renameAsset,
        replaceAssetFile: workspace.replaceAssetFile,
        restoreAsset: workspace.restoreAsset,
        purgeAsset: workspace.purgeAsset,
      }
    : null

  // Auto-open the viewer when a primary selection appears via a plain click.
  // We don't auto-open while a multi-selection is in flight (2+ items) —
  // that's the bulk-edit story.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (workspace.selectedAssetId && workspace.selectedAssetIds.size <= 1) {
      setViewerOpen(true)
    } else if (!workspace.selectedAssetId) {
      setViewerOpen(false)
    }
  }, [workspace.selectedAssetId, workspace.selectedAssetIds.size])

  // Auto-open the upload queue the moment something starts uploading. We
  // don't auto-close on completion — the user often wants to see the result
  // briefly and dismiss when ready.
  useEffect(() => {
    if (workspace.uploadQueue.active && !uploadQueueOpen) {
      setUploadQueueOpen(true)
    }
  }, [workspace.uploadQueue.active, uploadQueueOpen])

  // Bulk Edit auto-opens once a 2+ multi-selection exists, and auto-closes
  // when the selection collapses back to a single item or empty.
  useEffect(() => {
    if (workspace.selectedAssetIds.size >= 2) {
      setBulkEditOpen(true)
    } else if (workspace.selectedAssetIds.size <= 1) {
      setBulkEditOpen(false)
    }
  }, [workspace.selectedAssetIds.size])
  /* eslint-enable react-hooks/set-state-in-effect */

  const toolbarRightSlot = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setUploadQueueOpen((open) => !open)}
      aria-label="Toggle upload queue"
      pressed={uploadQueueOpen}
    >
      <UploadIcon size={13} />
      <span>Uploads</span>
      {workspace.uploadQueue.active && (
        <span aria-hidden="true" style={{ marginLeft: 4 }}>·</span>
      )}
    </Button>
  )

  return (
    <>
      <AdminWorkspaceCanvasLayout
        workspace="media"
        toolbarRightSlot={toolbarRightSlot}
        contentSidebar={(
          <MediaSidebar
            workspace={workspace}
            activePanel={activePanel}
            onActivePanelChange={setActivePanel}
          />
        )}
        contentCanvas={<MediaCanvas workspace={workspace} />}
        // No `contentRightPanel` — the asset inspector is a window now.
      />

      <MediaViewerWindow
        editor={viewerEditor}
        open={viewerOpen && workspace.selectedAssetId !== null && workspace.selectedAssetIds.size <= 1}
        onClose={() => {
          setViewerOpen(false)
          workspace.clearSelection()
        }}
      />

      <UploadQueueWindow
        queue={workspace.uploadQueue}
        open={uploadQueueOpen}
        onClose={() => setUploadQueueOpen(false)}
      />

      <BulkEditWindow
        workspace={workspace}
        open={bulkEditOpen && workspace.selectedAssetIds.size >= 2}
        onClose={() => {
          setBulkEditOpen(false)
          workspace.clearSelection()
        }}
      />
    </>
  )
}
