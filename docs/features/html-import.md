# HTML Import

`src/core/htmlImport` converts an HTML string into a flat fragment of first-class `PageNode`s that callers splice directly into the live page tree.

The module has two consumers: the paste-HTML UI (Phase 1, shipped) and the AI agent's `insertHtml` tool (Phase 2, not yet shipped). Both call the same `importHtml(source)` entry point — no duplicated mapping logic.

---

## TL;DR

- Single entry point: `importHtml(source)` → `{ nodes, rootIds, stripped }`.
- Pipeline: `parseHtml` → `stripUnsafe` → `walkAndMap`.
- Mapping is rule-driven (`HTML_TO_MODULE_RULES`). The catch-all `*` rule guarantees every element produces a node — nothing falls through.
- Every produced node is a real `PageNode`: selectable, draggable, deletable, and re-styleable in the canvas.
- HTML class names ride onto `node.classIds` during the pure walk; `insertImportedNodes` then links each name to a real registry class id (reusing a same-named class or auto-creating a bare one) so the class renders and is editable. No CSS rules are parsed or preserved.
- UX entry points: Spotlight **Import HTML** command and right-click **Paste HTML here…** on any container node.

---

## Where the code lives

```text
src/core/htmlImport/
├── index.ts           — public barrel; all exports below go through here
├── parseHtml.ts       — DOMParser.parseFromString wrapper (browser-only; tests polyfill via happy-dom)
├── stripUnsafe.ts     — removes <script>, <style>, on* attrs, style= attrs; returns StripReport
├── rules.ts           — HTML_TO_MODULE_RULES declarative mapping table
└── walkAndMap.ts      — DOM walker + importHtml() entry point

src/admin/modals/ImportHtml/
├── ImportHtmlModal.tsx        — modal: textarea, parent picker, live preview, error alert, footer buttons
├── ImportHtmlModal.module.css
└── index.ts                   — barrel re-export

src/admin/spotlight/commands/importHtml.ts  — Spotlight command editor.importHtml
src/__tests__/htmlImport/mapping.test.ts    — 95 per-rule unit tests
```

---

## The pipeline

`importHtml(source)` runs three steps in sequence:

```text
importHtml(source: string)
  1. parseHtml(source)      — new DOMParser().parseFromString(source, 'text/html')
                              Returns a DOM Document. Uses the global DOMParser;
                              no server-side DOM library is imported.
  2. stripUnsafe(doc)       — mutates doc in place; returns StripReport
  3. walkAndMap(doc)        — maps doc.body element children to PageNodes
                              Returns { nodes, rootIds }
→ { nodes, rootIds, stripped }   (ImportResult)
```

### Return type

```ts
interface ImportResult {
  /** All produced nodes, keyed by id. */
  nodes: Record<string, PageNode>
  /** IDs of the top-level nodes (direct children of doc.body), in document order. */
  rootIds: string[]
  /** Counts of constructs removed by stripUnsafe. */
  stripped: StripReport
}
```

Callers splice `nodes` and `rootIds` into the page tree via `insertImportedNodes(parentId, fragment)` in the editor store — one `mutateActiveTree` call, one undo step.

---

## Mapping rules

`HTML_TO_MODULE_RULES` in `src/core/htmlImport/rules.ts` is a declarative array of `ImportRule` objects. The walker tests each element against the rules in order; the first match wins. The last rule is always `*`, so every element is guaranteed to match.

| Selector | Module | Props set | Recurse |
|---|---|---|---|
| `h1`–`h6`, `p`, `span`, `small`, `strong`, `em` | `base.text` | `text` = `el.textContent`, `tag` = tag name | No |
| `a` with class `btn` | `base.button` | `label` = `el.textContent`, `href`, `target` | No |
| `a` (no `btn` class) | `base.link` | `text` = `el.textContent`, `href`, `target` | No |
| `img` | `base.image` | `src` = `src` attribute only | No |
| `button` | `base.button` | `label` = `el.textContent`, `disabled` | No |
| `ul`, `ol` | `base.container` | `tag` = tag name | Yes |
| `div`, `section`, `article`, `main`, `header`, `footer`, `nav`, `aside` | `base.container` | `tag` = tag name | Yes |
| `area`, `base`, `br`, `col`, `embed`, `hr`, `input`, `link`, `meta`, `param`, `source`, `track`, `wbr` (void elements) | `base.container` | `tag: 'custom'`, `customTag` = tag name | **No** |
| `*` (catch-all) | `base.container` | `tag: 'custom'`, `customTag` = tag name | Yes |

**Key details:**

- `base.text` uses `tag` (not a separate `level` or heading prop) — the tag name is passed through directly.
- **Direct text inside a recursing container is preserved.** The walker iterates `childNodes` (not just `children`): element children route through the rules, and each significant text node becomes a synthesized `base.text(tag:'span')` child in document order. So `<div class="num">98%</div>` and `<li>Buy milk</li>` import as a container holding their text — not an empty container. Whitespace-only text (indentation between tags) is skipped; internal whitespace runs collapse to single spaces.
- `base.link` uses the prop `text` (not `label`). `base.button` uses `label` (not `text`). These match the module source.
- `base.image` captures `src` only. `alt` is not a per-instance prop — it comes from the media library asset.
- **Void elements** (`<br>`, `<hr>`, `<input>`, etc.) have their own rule that sits before the catch-all. They map to `base.container` with `tag:'custom'` + the real tag name, but with `recurse:false` so the produced node has no children. The canvas renderer (`ContainerEditor`) also guards against passing children (including the empty-container placeholder) to void element tags, because React throws if you do so.
- The catch-all (`*`) handles `li`, `figure`, `blockquote`, `form`, `table`, `dialog`, and anything else not listed. It uses `tag: 'custom'` + `customTag` so `resolveHtmlTag` in `base.container` emits the real element name. Using `tag: 'div'` + `customTag` would render `<div>` instead.
- The pure `walkAndMap` step copies element class *names* onto `node.classIds` (`Array.from(el.classList)`) — it is registry-agnostic and infers no styles. The store action that splices the fragment in (`insertImportedNodes`) then converts those names to real class ids (see [Class linking](#class-linking-name--id)).

---

## What gets stripped

`stripUnsafe` (`src/core/htmlImport/stripUnsafe.ts`) mutates the parsed document before the walker runs:

| Removed | Counted as |
|---|---|
| `<script>` elements | `stripped.scripts` |
| `<style>` elements | `stripped.styles` |
| Inline `on*` attributes (`onclick`, `onload`, …) | `stripped.inlineHandlers` |
| `style="…"` attributes | `stripped.inlineStyles` |
| HTML comments and processing instructions | (silent — no count) |

After insert, `ImportHtmlModal` builds a toast body from non-zero counts, e.g. `"Stripped: 2 <script>, 3 inline handlers"`. If nothing was stripped, the toast shows only the node count.

---

## What is lossy by design

The importer is "approximate by construction". Several inputs do not survive the round-trip:

| Input | What happens | Why |
|---|---|---|
| `alt=""` on `<img>` | Dropped | `base.image` has no `alt` prop — alt text is stored on the media library asset |
| HTML attributes not modeled by the matched module (`id`, `data-*`, ARIA attrs, etc.) | Dropped — except `class` names, which become real registry classes linked by id (see [Class linking](#class-linking-name--id)) | The module schema is the source of truth for props |
| Exact inline whitespace around mixed content (`<div>Hello <em>world</em></div>`) | Approximated | Each text run becomes a `base.text(span)` child with whitespace collapsed to single spaces and the ends trimmed; the text itself is **preserved**, only exact spacing is normalized |
| Whitespace-only text (newlines/indentation between tags) | Dropped | It carries no content — collapsing it would add empty text nodes to every pretty-printed snippet |
| Void elements (`<br>`, `<hr>`, `<input>`, etc.) | Imported as a childless `base.container` node with `tag:'custom'` and the real tag name as `customTag`. No children, no empty-container placeholder. | React throws if children are rendered inside void element tags; the dedicated void-element rule (before the catch-all) sets `recurse:false` and the canvas renderer skips children entirely for void tags. |

These losses are deliberate. The importer is a structural bootstrap, not a fidelity snapshot.

---

## The UX

Three entry points all open the same `ImportHtmlModal`:

1. **Spotlight palette** — type "Import HTML" (`editor.importHtml` command, `code` icon). Opens with no parent pre-set (defaults to the page root) and an empty textarea.
2. **DOM panel context menu** — right-click any container node → **Paste HTML here…**. The clipboard is read and pre-fills the textarea; `parentId` is pre-set to the right-clicked node.
3. **Canvas context menu** — same as DOM panel, via `CanvasRoot.handlePasteHtml`.

The modal:
- **Textarea** — paste or type HTML.
- **"Insert inside" Select** — parent picker listing the page root and all container nodes. Pre-set to the entry point's `parentId`.
- **Live preview** — 200 ms debounced tree summary showing module names and prop snippets. Updates as the user types.
- **Insert** button — runs `importHtml`, calls `insertImportedNodes`, shows a success toast (with optional stripped-count detail), closes the modal.

After insert, every produced node is a normal canvas node. It can be selected, moved, re-styled, and deleted like any other node.

`ImportHtmlModal` is mounted in `AdminCanvasLayout.tsx` gated by `importHtmlModalOpen`:

```tsx
{importHtmlModalOpen && <ImportHtmlModal />}
```

---

## Class linking (name → id)

The engine's style rule registry (`site.styleRules`) is keyed by a generated **id**, and every renderer resolves a node's classes by id (`classNamesForClassIds` → `styleRules[classId].name`). HTML, however, carries class **names**. The two layers reconcile in `insertImportedNodes` (`src/admin/pages/site/store/slices/site/nodeActions.ts`):

1. The pure `walkAndMap` step writes raw names onto `node.classIds` (it has no `SiteDocument`, so it cannot mint ids).
2. As the fragment is spliced into the live tree, `insertImportedNodes` walks every fragment node's `classIds` and, for each name:
   - links to an **existing** class of that name if one exists (so `class="hero"` reuses your `hero` class), or
   - **auto-creates** a bare (style-less) class for that name.
3. The node's `classIds` are rewritten to the resolved ids in the same `mutateActiveTreeAndSite` transaction (one undo step).

The result: imported markup renders its `class` attribute, the classes show up in the Selectors panel, and they are immediately styleable — by the user in the editor or by the AI agent via `createClass` / the `insertHtml` `classes` array (which pre-creates the named classes **with** styles, so the link in step 2 finds them).

> Skipping this linking step is the bug that made HTML-authored styles silently never apply: names on `classIds` never matched the id-keyed registry, so the renderer dropped them. Regression-gated by `src/__tests__/agent/executor.test.ts`.

## CSS is out of scope

The importer never parses or preserves CSS **rules**. This is intentional:

- `<style>` blocks are stripped.
- `style="…"` inline attributes are stripped.
- Class **names** survive (linked to real registry classes per [Class linking](#class-linking-name--id)), but their **declarations** are not — an auto-created class starts style-less until styled in the editor or by the agent.

---

## Phase 2 (not yet shipped)

The same `importHtml` importer powers the AI agent's `insertHtml` tool. The agent writes semantic HTML for structure; the importer converts it to page nodes; the existing class tools (`createClass`, `updateClassStyles`, `assignClass`) handle styling. This replaces the current `insertNode` / `insertTree` tool surface.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Calling `walkAndMap` before `stripUnsafe` | Call `importHtml(source)` — it runs both in the correct order |
| Importing `parseHtml` or `walkAndMap` from inside `src/core/` via a deep path | Import through the barrel: `import { importHtml } from '@core/htmlImport'` |
| Adding a server-side DOM import to `parseHtml.ts` | If server-side parsing is needed, add a guarded dynamic import at the call site — `parseHtml.ts` must stay importable in the browser bundle without bundling a DOM library |
| Storing `alt` text on `base.image` nodes produced by the importer | `base.image` has no `alt` prop; alt lives on the media library asset |

---

## Related

- [docs/features/modules.md](modules.md) — module definitions, `base.text`, `base.button`, `base.image`, `base.container`
- [docs/features/agent.md](agent.md) — AI agent feature; Phase 2 will add `insertHtml` here
- [docs/reference/page-tree.md](../reference/page-tree.md) — `NodeTree<PageNode>`, `createNode`, `ImportFragment` shape
- Source-of-truth files:
  - `src/core/htmlImport/index.ts` — public barrel + API documentation
  - `src/core/htmlImport/rules.ts` — `HTML_TO_MODULE_RULES` mapping table
  - `src/core/htmlImport/walkAndMap.ts` — `importHtml()`, `walkAndMap()`, `ImportResult`, `ImportFragment`
  - `src/core/htmlImport/stripUnsafe.ts` — `stripUnsafe()`, `StripReport`
  - `src/admin/modals/ImportHtml/ImportHtmlModal.tsx` — paste-HTML modal
  - `src/admin/spotlight/commands/importHtml.ts` — Spotlight command
- Gate tests:
  - `src/__tests__/htmlImport/mapping.test.ts` — 95 per-rule mapping tests
