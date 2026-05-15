# Responsive Media Pipeline — Plan

End-to-end rebuild of how the CMS handles images (and, to a lighter extent, videos): proper responsive variants, BlurHash placeholders, lazy loading, modal-based picker shared with the Media page. The Image and Video modules get rewritten so the published page output is the kind of clean, modern HTML the rest of the project targets.

> Status: design / proposal. Migrations and pipeline land in milestones — see **Phases** at the end. Nothing in this doc is shipped yet.

---

## What's wrong today

1. **No responsive variants.** The image module emits a single `<img src loading>` with the original file at whatever resolution the user uploaded. A 4 MB hero PNG is served to a mobile phone showing it at 320 px wide.
2. **No BlurHash.** Every preview pops in from blank/grey. Media page grid, picker, canvas — all loading 4 MB originals to render 140 px thumbs.
3. **Alt text is duplicated.** The Image module's `alt` prop is free text, completely disconnected from `media_assets.alt_text` saved via the Media page. Edit alt text in one place, nothing updates in the other.
4. **Picker UX is cramped.** `MediaLibraryControl` lives in the right-sidebar property panel (~280 px wide). Selected-state is a faint outline. No folder navigation, no proper sort, no tag filter. You can't tell from a glance which asset is picked.
5. **No intrinsic dimensions in the markup.** Missing `width`/`height` causes layout shift while the image loads — bad CLS.
6. **No fetchpriority / decoding hints.** Modern image-perf knobs that take five minutes to wire up.
7. **No format conversion.** A 2 MB PNG that would be 200 KB as WebP stays a 2 MB PNG.

---

## Design — three layers

### 1. Server-side pipeline

On every upload (`acceptUploadedMedia`) and "replace file" (`acceptReplacementMedia`), the server does the work once and stores the results:

- **Probe dimensions** — `width`, `height`. Already have the columns from M1, just need to populate them.
- **BlurHash** — encode a ~30-char string. Stored on `media_assets.blur_hash`.
- **Variant set** — for each target width that's smaller than the original, produce a WebP variant:
  - `320`, `640`, `1024`, `1600`, `2048` widths by default. Skip any width ≥ the original (no upscaling).
  - Plus a small `64` "tiny" used by the picker / canvas thumbnails so they don't share with the 320.
  - Variants live next to the original under `/uploads/`, named `<id>-w<width>.webp`.
- **Format conversion** — WebP only in the first cut. AVIF is a future flag (better compression, much slower encode; not worth blocking on).
- **Originals are preserved untouched.** Replace flow gets new variants too.

**Library choice.** `sharp` (Node-API binding to libvips). Works under Bun, dominates the Node ecosystem for image processing, supports WebP/AVIF/JPEG/PNG/GIF in one API. Native dep but small and well-maintained. Alternative `@cf-wasm/photon` (WASM, no native binary) — keep in pocket for serverless deploys; out of scope for v1.

**Schema additions** (new migration, both PG + SQLite):

| Column          | Type                            | Notes                                       |
|-----------------|---------------------------------|---------------------------------------------|
| `blur_hash`     | `text`                          | Nullable — only images get one.             |
| `variants_json` | `jsonb` (PG) / `text` (SQLite)  | `MediaVariant[]` — see below.               |

```ts
interface MediaVariant {
  width: number        // intrinsic width of this variant
  height: number       // intrinsic height
  format: 'webp' | 'jpeg' | 'png' | 'avif'
  path: string         // /uploads/<storage>-w320.webp
  sizeBytes: number
}
```

`MediaAsset` (the domain type) gains `blurHash: string | null` and `variants: MediaVariant[]`. Wire schema already optional via the same pattern we used for M2 fields.

**Backfill.** Existing rows (uploaded before this lands) won't have variants or blur. A one-shot script (`scripts/backfill-media-variants.ts`) walks `media_assets` where `variants_json IS NULL OR variants_json = '[]'` and runs the pipeline on each storage_path. Idempotent — safe to re-run.

**Async vs sync.** Generating five WebP variants takes ~200–500 ms per image at upload time. Acceptable to block the upload response — the upload queue UI already shows progress and would just stay "uploading" a beat longer. If it becomes too slow we move it to a background job. For v1, **synchronous on upload**.

### 2. Image module rewrite

New schema:

```ts
interface ImageProps {
  // Primary: asset id reference. When set, we render full responsive markup.
  mediaId: string | null
  // Fallback: external URL (or a legacy `/uploads/...` path). Used when
  // mediaId is null, or as a graceful degrade if the asset is missing.
  src: string
  // Override of asset alt text. Empty → use `asset.altText` from the
  // library (single source of truth for accessibility metadata).
  alt: string
  // 'auto' computes sizes from the canvas breakpoints. A custom string
  // (e.g. "(min-width: 1024px) 50vw, 100vw") gets emitted verbatim.
  sizes: 'auto' | string
  loading: 'lazy' | 'eager'
  fetchPriority: 'auto' | 'high' | 'low'
  decoding: 'async' | 'sync' | 'auto'
}
```

Render output for an asset with variants:

```html
<img
  src="/uploads/abc-w1024.webp"
  srcset="/uploads/abc-w320.webp 320w,
          /uploads/abc-w640.webp 640w,
          /uploads/abc-w1024.webp 1024w,
          /uploads/abc-w1600.webp 1600w,
          /uploads/abc-w2048.webp 2048w"
  sizes="(min-width: 1024px) 50vw, 100vw"
  width="2400"
  height="1600"
  alt="Mountain villa at dusk"
  loading="lazy"
  decoding="async"
  fetchpriority="auto"
  style="background-image: url('data:image/svg+xml,...'); background-size: cover;"
>
```

The `style` carries a tiny SVG-encoded BlurHash so the box is filled instantly while the WebP downloads. Once `decoding="async"` finishes, the real image paints over it. Removed from the markup if `loading="eager"` and `fetchPriority="high"` — those are above-the-fold cases where blur-then-paint is worse than just letting the browser show the image.

**`sizes="auto"` resolution.** At publish time we know:
- The site's breakpoints from `framework.breakpoints`.
- The width the image's container ends up at each breakpoint (harder — needs runtime layout info).

For v1, `auto` resolves to a sane default: `100vw` everywhere. The user can override by typing a real `sizes` string. A future smarter `auto` could walk the page tree to compute container widths per breakpoint, but that's a separate pass.

**Backward compatibility.** Pages already saved with `src: '/uploads/foo.png'` and no `mediaId`:
- Publisher matches `publicPath = src` against `media_assets`. If hit → upgrade in-flight to responsive markup. No data migration needed.
- If miss → falls back to plain `<img>` (external URL or deleted asset).

### 3. Picker — modal Media page

`MediaLibraryControl`'s cramped 280 px sidebar dies. Replaced by a `MediaPickerDialog` that mounts a slimmed version of the Media page inside a fullscreen modal:

```
┌─────────────────────────────────────────────────────────────────┐
│ Select an image                                          [×]    │
├──────────┬──────────────────────────────────────┬───────────────┤
│ Folders  │ FilterBar: type · search · sort      │ Inspector     │
│  📁 all  │ ┌────┬────┬────┬────┬────┐           │ Preview       │
│  📁 hero │ │ ▓  │ ▓  │ ◼  │ ▓  │ ▓  │ blur-pop  │ Filename      │
│  📁 ...  │ └────┴────┴────┴────┴────┘           │ Alt text      │
│          │                                      │ ...           │
│ Smart    │                                      │               │
│  ⌚ Recent│                                      │               │
│  ⚠ NoAlt │                                      │               │
├──────────┴──────────────────────────────────────┴───────────────┤
│                              [Cancel]  [Use selected] →         │
└─────────────────────────────────────────────────────────────────┘
```

- Visually it's the Media page in a dialog. Folders tree, smart folders, asset grid, viewer-style inspector.
- **Clear "selected" state** — the picked tile gets a coloured ring (`--canvas-selection-ring`) plus a check badge. Not the current 1px outline.
- "Use selected" stores `mediaId` (and `src` derived from `asset.publicPath` for the back-compat path).
- Multi-select hidden behind a v2 prop. Single-select is enough for `<img>` / `<video>`.

The existing `src/admin/pages/content/components/MediaPickerDialog/` is a different component (used by content blocks) — we either rename our new one to `MediaPickerModal` or fold the content one into this. I'd rename ours to keep that orthogonal.

### 4. Admin uses small variants + BlurHash

Once variants exist server-side, the admin stops eating its own dogfood:

- **Media canvas grid** — pick the smallest variant ≥ the tile's rendered CSS width (currently ~140 px → fetch `w320.webp`). BlurHash bg while it streams in.
- **MediaViewerWindow image** — pick the variant closest to the viewer's preview area (~600 px wide → `w640.webp`). Full original only fetched if the user clicks "Open in new tab".
- **MediaPickerDialog grid** — same small variant.
- **Editor canvas image module preview** — full responsive markup, same as published. The editor IS the renderer.

**BlurHash rendering.** We decode to a small (e.g. 32×32) image via the `blurhash` package's `decode()`, paint it to a canvas, and convert to a `data:image/png;base64,...` URL. Cached per BlurHash string in a small in-memory LRU (most users see the same library across many tiles). Cheap.

---

## Video module — lighter rewrite

Video gets a smaller treatment in v1. Multi-resolution / adaptive-bitrate is a real project unto itself; we don't tackle it now. What we do:

- **Poster image on upload.** Extract frame at t=1s, save as a JPEG variant. Store path on `media_assets.poster_path` (or as a variant with `kind: 'poster'`).
- **Width / height probe** so the markup carries intrinsic dimensions.
- **Render upgrades** — add `poster`, `playsinline`, `preload="metadata"`, `width`, `height`, and the existing `controls`/`autoplay`/`loop`/`muted` toggles. Plus the same `<video>`-with-blurhash trick using the poster as background.

Out of scope for v1:
- Re-encoding to MP4/WebM/AV1 variants.
- HLS or DASH manifests.
- Multiple-resolution `<source>` siblings.

---

## What I'm NOT doing in v1

- AVIF generation (WebP is enough for now; AVIF doubles encode time).
- Image cropping / editing in-browser.
- Animated GIF → MP4 conversion.
- CDN integration (still local-disk; the variant filenames are CDN-friendly when we add one).
- Smart sizes resolver that walks the page tree.
- Per-asset cache busting (we keep stable storage paths; a "replace file" already invalidates the cache through CSS query strings or a future `?v=` hash).
- Server-side WebP support detection. We emit WebP unconditionally — Safari 14+, Chrome, Firefox all support it. The `<picture>` fallback layer is a v2 if we hit a real-world Safari-13-or-older user.

---

## Phases

**N1 — Server pipeline**
- New migration: `020_media_responsive_variants` adds `blur_hash`, `variants_json`. PG + SQLite.
- Add `sharp` + `blurhash` deps.
- Extend `acceptUploadedMedia` / `acceptReplacementMedia` with `processImageVariants()` + `processVideoPoster()`.
- Backfill script for existing rows.
- Extend `CmsMediaAssetSchema` + `MediaAsset` repo type with `blurHash`, `variants`, `posterPath`.

**N2 — BlurHash + variants in admin**
- `useBlurHashUrl(hash)` helper (decode + canvas + data-URL).
- Media canvas grid + viewer preview + picker pick the right variant.
- BlurHash backdrop on every async-loading image surface.

**N3 — MediaPickerDialog modal**
- New full-modal picker that hosts (folders tree, grid, inspector) with "Use selected" CTA.
- `MediaLibraryControl` rewires to open the modal — strip the inline list.
- Strong "selected" affordance + clear current-asset display.
- Replaces the cramped sidebar picker entirely.

**N4 — Image module rewrite**
- Add `mediaId`, `sizes`, `fetchPriority`, `decoding` props. Keep `src` / `alt` / `loading`.
- Render full responsive `<img>` with srcset/sizes/blurhash/intrinsic dims when `mediaId` resolves.
- Back-compat path: resolve `src` → `mediaId` on the fly when `src` matches a known `/uploads/` asset.
- Editor canvas + publisher both emit the same markup.

**N5 — Image module ↔ Media page alt text**
- When `alt` prop is empty AND a `mediaId` resolves → fall back to `asset.altText` at render time.
- Optional UI: "Use library alt text" button in the property control that clears the prop's local alt and pins it to "follow asset".

**N6 — Video module rewrite**
- Add `mediaId`, `poster`, `playsinline`, `preload`, `width`/`height` props.
- Renderer emits intrinsic dimensions + poster.
- Picker swap to the same modal.

---

## Open questions

1. **Use `<picture>` or just `<img srcset>`?**
   - `<img srcset>` covers width-based variants and is simpler.
   - `<picture>` is needed for format-fallback (AVIF→WebP→JPEG) and art-direction (crop changes per breakpoint).
   - v1 ships `<img srcset>`. Move to `<picture>` when AVIF lands.

2. **Where to store variants on disk?**
   - Side-by-side under `/uploads/<id>-w320.webp`. Simple and predictable.
   - Alternative: a per-asset subdirectory `/uploads/<id>/w320.webp`. Cleaner listings, harder migrations.
   - I'd start with side-by-side; subdirs are easy to retrofit if needed.

3. **What to do about WordPress-imported sites (future)?**
   - Out of scope here. WordPress would expose its own `wp-content/uploads/2024/foo-300x200.jpg` pattern that we wouldn't try to ingest.

4. **Animated images (GIF, animated WebP).**
   - Keep the original animated, only generate static thumbnails at smaller sizes.
   - For published output, serve the original GIF/WebP — don't try to convert.

5. **The user's "search input is not using our UI component" feedback.**
   - The current `MediaLibraryControl` already uses `<SearchBar>` from `@ui/components/SearchBar`. SearchBar internally renders our `<Input>` plus an icon affordance. Visually it has the magnifying glass and bordered chrome that match the rest of the editor.
   - In the screenshot the cramped sidebar layout might be making it look "different". Going through the modal picker (N3) gives this room to breathe and should resolve the perception.
   - If it still feels off after N3, we tweak SearchBar's styling there — but no separate input component is needed.
