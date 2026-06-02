# Media

The Media workspace — a dedicated admin page for managing every file on the site. Folder tree, file grid, bulk operations, usage tracking, floating windows for upload queue / viewer / bulk edit. Lives at `/admin/media`.

The workspace is canvas-style: it uses `AdminWorkspaceCanvasLayout`, the lighter canvas shell shared by Content, Data, and Media. The sidebar is a panel rail with folder-tree navigation / storage controls; the canvas is an OS-style file manager grid driven by `MediaCanvas`, where folders and assets share the same browsing surface. Overlays are draggable windows persisted via `panelLayoutStorage`.

---

## TL;DR

- **Route:** `/admin/media`, capability-gated by `media.manage`.
- **Page entrypoint:** `src/admin/pages/media/MediaPage.tsx`.
- **State:** one hook — `useMediaWorkspace()` — orchestrates folders, assets, selection, filters, upload queue, and folder moves. The editor store doesn't grow new slices; the Media page is self-contained.
- **Folders:** folders render as first-class grid/list items in the canvas. Opening a folder filters the canvas to its contents, and nested folders show a parent-folder entry to navigate back.
- **Drag/drop:** assets can be dragged into folders from the canvas or folder tree. A drop replaces the asset's folder memberships with the target folder, matching desktop file-manager move semantics.
- **Floating windows:** Asset viewer, upload queue, bulk edit. Each is `useDraggablePanel('mediaViewer' | 'mediaUploadQueue' | 'mediaBulkEdit')`. Position survives reload via `panelLayoutStorage`.
- **Auto-open behavior:** upload queue opens when uploads start; bulk-edit opens at 2+ selected; viewer opens on primary selection.
- **Server side:** `media_assets`, `media_folders`, `media_asset_folders` tables. Handlers under `/admin/api/cms/media`, `/admin/api/cms/media/folders`, `/admin/api/cms/media/storage`. Repositories at `server/repositories/media*.ts`.
- **Storage adapters:** built-in local-disk plus plugin-registered adapters. Non-public-url adapters route through `/_instatic/media/<adapterId>/<storagePath>` for signed redirects.

---

## Folder layout

```text
src/admin/pages/media/
├── MediaPage.tsx                       — top-level component
├── components/
│   ├── MediaSidebar/                   — folder tree + storage + smart folders
│   ├── MediaCanvas/                    — file grid / list with FilterBar
│   ├── MediaViewerWindow/              — floating asset viewer
│   ├── UploadQueueWindow/              — floating upload progress
│   ├── BulkEditWindow/                 — floating multi-select editor
│   ├── TagEditor/                      — tag-management UI
│   ├── ReplaceFileDialog/              — replace binary keeping same id / URL
│   ├── MediaPickerModal/               — modal-style picker (used from other workspaces)
│   ├── MediaPickerField/               — embedded picker control
│   ├── MediaFolderPanel/               — folder list panel
│   ├── MediaStoragePanel/              — storage adapter management
│   ├── FloatingWindow/                 — shared floating-window shell
│   └── viewers/                        — per-media-type viewers (image, video, pdf, etc.)
├── hooks/
│   ├── useMediaWorkspace.ts            — orchestrates server state (folders, assets, filters)
│   ├── useUploadQueue.ts               — XHR/fetch upload pipeline + progress events
│   ├── useStandaloneMediaEditor.ts     — alt-text / caption / tags editor
│   ├── useCmsMediaAssetByPath.ts       — single-asset lookup by path
│   └── useDebouncedSave.ts             — generic debounced save helper
└── utils/
    ├── filters.ts                      — type/date/folder filter predicates
    ├── folderTree.ts                   — folder utilities: tree build, descent check, child listing
    ├── mediaDragDrop.ts                — TypeBox-validated drag/drop payload helpers
    ├── smartFolders.ts                 — smart folder IDs, type guard, per-ID predicates
    └── variants.ts                     — image variant URL helpers
```

---

## Page architecture

```text
<AdminWorkspaceCanvasLayout>                         ← shared non-site canvas shell
  toolbar:                                           ← Upload + Bulk + … buttons
  sidebar: <MediaSidebar activePanel={…}>            ← Folders | Storage | Smart folders
  canvas:  <MediaCanvas …>                           ← folder + file grid / list
  overlays (floating windows):
    <MediaViewerWindow>     ← primary selection
    <UploadQueueWindow>     ← active uploads
    <BulkEditWindow>        ← 2+ selected
```

`MediaPage` orchestrates window visibility in local state and reads `useMediaWorkspace()` for everything else. Window **position** lives in `panelLayoutStorage` (`useDraggablePanel(id)`); window **visibility** is local React state with auto-open rules.

### `useMediaWorkspace` — the orchestrator

A single hook returns the full workspace state:

```ts
const {
  folders,        // tree of folders + All files + Trash
  assets,         // current filter results
  selection,      // Set<assetId> + primary
  filter,         // type / folder / date / query
  upload,         // queue + progress
  // … plus actions: rename, move, delete, replace, tag, etc.
} = useMediaWorkspace()
```

The editor store does **not** grow new slices. The Media page is self-contained — it talks to the CMS API directly through the persistence layer.

### Folder navigation and moves

`MediaCanvas` treats folders as regular canvas items:

- In **All files**, root folders render before the full asset list; type/search/tag filters apply to assets globally, not only to root-level files.
- Inside a folder, immediate child folders render before assets, and a parent-folder item appears at the start of the grid/list.
- Type filters other than `All` and active tag filters hide folder items so filtering remains literal. Search still matches folder names when folders are visible.

Drag/drop uses a media-specific `DataTransfer` payload helper in `src/admin/pages/media/utils/mediaDragDrop.ts`. Canvas folder items, the parent-folder item, and regular folder rows in `MediaFolderPanel` all accept the same payloads:

- Asset drops call `useMediaWorkspace().moveAssetsToFolder(assetIds, targetFolderId)`.
- Folder drops call the existing `moveFolder(folderId, parentId)` action after UI-side cycle/no-op checks.
- Dropping on **All files** moves assets/folders back to the root (`targetFolderId: null`).

Storage remains `media_asset_folders` (many-to-many), but the canvas move interaction is intentionally file-manager-like: moving an asset to a folder removes its previous folder assignments and adds only the target folder. The user-facing model is one current folder per asset move.

### Smart folders

Smart folders are virtual views in the sidebar that match assets by predicate rather than by folder membership. They appear in the **Library** section of `MediaFolderPanel` (above the folder tree), alongside "All files", and use the same `FolderSelection` union type (`SmartFolderId`). The predicate for each ID lives in `src/admin/pages/media/utils/smartFolders.ts`.

| Smart folder ID          | Label               | Matches                                          | Scope       |
|--------------------------|---------------------|--------------------------------------------------|-------------|
| `smart:missing-alt`      | Missing alt text    | `altText.trim()` is empty                        | Images only |
| `smart:missing-title`    | Missing title       | `title.trim()` is empty                          | Images only |
| `smart:untagged`         | Untagged            | `tags` array is empty                            | All assets  |
| `smart:large-files`      | Large files         | `sizeBytes > 1 MiB`                              | All assets  |
| `smart:recently-replaced`| Recently replaced   | `replacedAt !== null`                            | All assets  |

"Images only" means the predicate short-circuits to `false` for any `mimeType` that doesn't start with `image/`. Fonts, documents, videos, and audio files are never matched by the image-metadata smart folders even when those fields are empty.

Standard filters (type chip, search, tag) still apply inside a smart folder view — `useMediaWorkspace` runs the smart predicate on top of the already-filtered list (`filteredAssets → visibleAssets`).

The count badge shown next to each smart folder in the sidebar is computed client-side from `workspace.assets` using `smartFolderPredicate(id)` directly — no extra server round-trip.

### Floating windows

Each floating window:

- Has a unique `FloatingPanelId`: `'mediaViewer' | 'mediaUploadQueue' | 'mediaBulkEdit'`.
- Uses `useDraggablePanel(id)` to read / write position.
- Uses local `useState` in `MediaPage` for `open: boolean`.
- Auto-opens by rule (upload start, 2+ selected, primary selection).
- Persists position via `panelLayoutStorage.ts`.

The shared `FloatingWindow` shell at `components/FloatingWindow/` provides the chrome: drag handle, close button, position bounding.

---

## Data model

Media data lives in dedicated tables (not in `data_tables` — they predate the universal store and have media-specific columns and a public-path index).

### `media_assets`

| Column            | Type (PG)     | Type (SQLite) | Notes                                                          |
|-------------------|---------------|---------------|----------------------------------------------------------------|
| `id`              | `text` PK     | `text` PK     |                                                                |
| `filename`        | `text`        | `text`        | Original upload filename                                       |
| `public_path`     | `text`        | `text`        | URL path: `/uploads/...` or `/_instatic/media/<adapter>/<path>`      |
| `mime_type`       | `text`        | `text`        |                                                                |
| `size_bytes`      | `bigint`      | `integer`     |                                                                |
| `width`           | `integer`     | `integer`     | Nullable, populated on image upload                            |
| `height`          | `integer`     | `integer`     | Nullable                                                       |
| `duration_ms`     | `integer`     | `integer`     | Nullable, for video / audio                                    |
| `alt_text`        | `text`        | `text`        | Required for accessibility                                     |
| `caption`         | `text`        | `text`        | Optional                                                       |
| `title`           | `text`        | `text`        | Optional; falls back to filename                               |
| `tags_json`       | `jsonb`       | `text`        | `string[]`, sorted lowercase                                   |
| `dominant_color`  | `text`        | `text`        | Nullable, `#rrggbb`. Computed server-side on upload            |
| `blurhash`        | `text`        | `text`        | Nullable. Used for skeleton placeholders                       |
| `variants_json`   | `jsonb`       | `text`        | Per-variant URL + dimensions                                   |
| `storage_adapter` | `text`        | `text`        | Adapter id (`local-disk` or plugin-registered)                 |
| `storage_path`    | `text`        | `text`        | Path inside the adapter                                        |
| `deleted_at`      | `timestamptz` | `text`        | Nullable. Non-null = soft-deleted (in Trash)                   |
| `replaced_at`     | `timestamptz` | `text`        | Nullable. Set when binary is swapped via "Replace file"        |
| `created_at`      | `timestamptz` | `text`        |                                                                |
| `updated_at`      | `timestamptz` | `text`        |                                                                |

### `media_folders`

```sql
create table media_folders (
  id text primary key,
  parent_id text references media_folders(id) on delete cascade,
  name text not null,
  slug text not null,
  sort_order integer not null default 0,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default current_timestamp,
  unique (parent_id, slug)
)
```

Slug auto-generated from name. `parent_id IS NULL` = root folder. Uniqueness scoped per parent, so two "Logos" folders under different parents are allowed.

### `media_asset_folders` (many-to-many)

```sql
create table media_asset_folders (
  asset_id text not null references media_assets(id) on delete cascade,
  folder_id text not null references media_folders(id) on delete cascade,
  primary key (asset_id, folder_id)
)
create index media_asset_folders_folder_idx on media_asset_folders (folder_id)
```

Assets with no folder rows are root-level assets. The **All files** view still includes every active asset, while drag/drop onto **All files** clears folder membership and moves the asset back to the root.

JSON columns end in `_json` per the convention — see [docs/reference/database-dialects.md](../reference/database-dialects.md).

---

## Server side

### Handlers

| Handler                          | Routes                                                     |
|----------------------------------|------------------------------------------------------------|
| `server/handlers/cms/media.ts`   | `GET/POST/PATCH/DELETE /admin/api/cms/media[/:id]`         |
| `server/handlers/cms/mediaFolders.ts` | `GET/POST/PATCH/DELETE /admin/api/cms/media/folders[/:id]` |
| `server/handlers/cms/mediaUpload.ts`, `mediaUploadDispatch.ts`, `mediaUploadExecutor.ts` | `POST /admin/api/cms/media/upload` + dispatcher / executor pipeline |
| `server/handlers/cms/mediaStorageAdmin.ts`, `mediaStorageMigration.ts`, `mediaStorageReader.ts` | `/admin/api/cms/media/storage[/...]` — manage adapters, kick off migrations |
| `server/handlers/cms/mediaVariants.ts` | Variant manifest read for an asset                    |

Folder routes (`/admin/api/cms/media/folders/...`) are matched **before** asset routes (`/admin/api/cms/media/:id`) because the latter would otherwise eat them. Same for storage routes (`/admin/api/cms/media/storage/...`). See `server/handlers/cms/index.ts`.

### Repositories

| File                                          | Owns                                            |
|-----------------------------------------------|-------------------------------------------------|
| `server/repositories/media.ts`                | `media_assets` CRUD + queries                   |
| `server/repositories/mediaFolders.ts`         | `media_folders` + `media_asset_folders`         |
| `server/repositories/mediaMigration.ts`       | Migrating assets between storage adapters       |
| `server/repositories/mediaStorageAdapters.ts` | Adapter registry persistence                    |

### Upload pipeline

```text
POST /admin/api/cms/media/upload
    │
    ▼
mediaUpload.ts             ← validates upload (size + magic-byte MIME sniff)
    │
    ▼
mediaUploadDispatch.ts     ← dispatches to the elected storage adapter
    │
    ▼
mediaUploadExecutor.ts     ← executes write (local disk or plugin adapter)
    │
    ▼
mediaVariants.ts (host)    ← coordinates variant generation
    │                       (delegate election runs host-side: when a
    │                       Tier-3 delegate is elected, the worker skips
    │                       the local ladder and we emit URL-template
    │                       variants only)
    ▼
imageVariantWorker          ← Bun.Worker: sharp probe + blurhash + WebP
  (server/handlers/cms/      ladder. Bytes cross the boundary as
   imageVariantWorker.ts)    transferable ArrayBuffers. The main thread
                             stays free for visitor traffic during the
                             ~200–500 ms CPU spend per upload.
    │
    ▼
mediaVariants.ts (host)    ← streams each returned variant through
                             dispatchUpload(role: 'variant') so the
                             elected adapter writes the bytes
    │
    ▼
media_assets row created, variants_json populated
```

The image-variant worker pool is sized by `IMAGE_VARIANT_WORKER_POOL_SIZE` (default 2, hard cap 8). Workers are spawned lazily on first use and reused for the life of the process; a crashed worker is dropped from the pool and a replacement spawns on the next submission.

Defense in depth on the static path: `hardenUploadResponse` in `server/static.ts` adds `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` for non-inert MIME types so a stray non-allowlisted upload can't be top-level navigated and rendered as HTML on the admin origin.

### Storage adapters

Built-in: local-disk (`mediaStorageRegistry.configureLocalDisk(...)` at boot). Plugin-registered: adapters added via the plugin SDK with their own `getReadUrl` / write semantics.

Two serving modes:

- **`public-url`** — the adapter returns a public URL the browser hits directly (or via CDN). Used by local-disk (`/uploads/...`).
- **non–`public-url`** — the asset URL is host-owned (`/_instatic/media/<adapterId>/<storagePath>`); the browser hits the host, which 302-redirects to a freshly-signed read URL.

The redirect handler is `tryServeMediaRedirect` in `server/router.ts`. The redirect target has a 1-hour TTL — long enough for browser fetches, short enough that a leaked signed URL becomes useless fast.

---

## Adding a new feature to the Media page

### Add a new column to `media_assets`

1. Add the column to both `server/db/migrations-pg.ts` and `migrations-sqlite.ts` with the same migration ID.
2. JSON column → name ends in `_json`.
3. Extend the asset TypeBox schema in `src/core/persistence/cmsMedia.ts`.
4. Add a setter handler in `server/handlers/cms/media.ts`.
5. Expose it in the asset viewer (`MediaViewerWindow`) and bulk-edit window (`BulkEditWindow`) if appropriate.

### Add a new floating window

1. Add a unique id to `FloatingPanelId` in the layout storage module.
2. Create `components/<WindowName>/` with the window React component using the shared `FloatingWindow` shell.
3. Use `useDraggablePanel('newWindowId')` for position; track `open` in `MediaPage` local state.
4. Add the auto-open rule (selection threshold, upload event, etc.) inside `MediaPage`.

### Add a new sidebar panel

1. Add the panel id to `MediaSidebarPanelId` in `components/MediaSidebar/MediaSidebar.tsx`.
2. Render the panel body inside the sidebar conditional.
3. Add the rail button: use `assignRailAccents` from `@ui/railAccent` to derive tints for the full rail item list (avoids repeats), then pass the resolved accent as `--rail-icon-tint` via an inline CSS custom property on the button. See `MediaSidebar.tsx` for the pattern.

### Register a plugin storage adapter

See [docs/features/plugin-system.md](plugin-system.md). The plugin SDK's `api.cms.media.registerStorageAdapter(adapter)` (under `unstable.internals` today) provides the registration surface. Adapters declare a `servingMode` and either return public URLs or implement `getReadUrl(storagePath, ttlSeconds)` for signed redirects.

---

## Forbidden patterns

| Pattern                                                              | Use instead                                                 |
|----------------------------------------------------------------------|-------------------------------------------------------------|
| Storing media metadata as JSON on the page tree                      | `media_assets` row with a foreign key                       |
| Hardcoding `/uploads/...` URLs in modules                            | Use the asset's `public_path` (the host owns the URL shape) |
| Filling `<img>` `srcset` manually                                    | Use `variants_json` + the publisher's `mediaPresentation.ts`|
| Adding a docked panel to the Media page                              | Use a floating window — Media is canvas-style by design     |
| Calling `api.cms.media.*` from a plugin without `unstable.internals` | Adapter registration is still gated to first-party plugins  |
| Treating `deleted_at IS NOT NULL` rows as gone                       | They're in Trash; restore is supported until purge          |
| Skipping `parent_id, slug` uniqueness when creating folders          | The unique constraint enforces it — handle the error path   |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview (request lifecycle includes `/_instatic/media/`)
- [docs/server.md](../server.md) — server-side handlers and storage adapters
- [docs/editor.md](../editor.md) — admin workspace layout (Media uses `AdminWorkspaceCanvasLayout`)
- [docs/reference/database-dialects.md](../reference/database-dialects.md) — `_json` columns + migration parity
- Source-of-truth files:
  - `src/admin/pages/media/MediaPage.tsx` — top-level workspace
  - `src/admin/pages/media/hooks/useMediaWorkspace.ts` — orchestrator
  - `src/admin/pages/media/hooks/useUploadQueue.ts` — upload pipeline
  - `src/admin/pages/media/utils/smartFolders.ts` — smart folder IDs + predicates
  - `src/core/persistence/cmsMedia.ts` — client-side schema + API
  - `server/handlers/cms/media*.ts` — handlers
  - `server/repositories/media*.ts` — repositories
  - `server/publish/mediaPresentation.ts`, `mediaPrefetch.ts` — publisher integration
  - `@core/plugins/mediaStorageRegistry` — storage adapter registry
- Gate tests:
  - `src/__tests__/architecture/media-migration-invariants.test.ts`
  - `src/__tests__/architecture/media-presentation-pipeline.test.ts`
  - `src/__tests__/architecture/media-signed-redirect-serving.test.ts`
  - `src/__tests__/architecture/media-storage-no-bytes-in-sandbox.test.ts`
  - `src/__tests__/architecture/media-storage-panel.test.ts`
