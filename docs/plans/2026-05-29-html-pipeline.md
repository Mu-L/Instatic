# HTML pipeline — paste-to-canvas import + AI writes HTML

A plan to build one HTML→tree pipeline with two clients: a paste-HTML import flow for users, and a refactored AI agent that writes HTML instead of structured tree JSON. The same `walkAndMap` walker serves both. The module engine, plugin SDK, publisher, and page-tree primitive are not changed.

This is a plan, not a doc. It describes work that has not been built. When it ships, the lasting parts move to `docs/features/html-import.md` and an update to `docs/features/agent.md`; this file is deleted.

---

## TL;DR

- **One importer, two clients.** A new module at `src/core/htmlImport/` parses an HTML string into a `PageNode[]` subtree. The paste-HTML UI uses it; the AI agent uses it. No duplicated logic, no second mapping table.
- **Every imported element becomes a first-class node.** Selectable, draggable, deletable, styleable in the canvas just like any other node. The catch-all rule maps any tag the table doesn't handle into `base.container` with `customTag` — that's how the system already represents arbitrary HTML tags, so nothing falls through.
- **CSS is out of scope.** Class names on imported elements ride through onto `node.classIds`. No CSS parsing, no class-registry insertions, no inline-style promotion, no `@media` handling. External CSS file imports are a separate workstream; the two import paths compose at runtime because class identities are preserved through both.
- **Agent goes HTML-native.** Today's `insertNode` and `insertTree` tools are retired (pre-release, no shims). Three new tools take their place: `insertHtml`, `getNodeHtml`, `replaceNodeHtml`. The agent writes semantic HTML for structure and uses the existing class tools (`createClass`, `updateClassStyles`, `assignClass`) for styling — including per-breakpoint variation via `breakpointStyles`. System prompt loses the module-ID enumeration and the per-module prop-name guidance.
- **Two phases, ~2–2.5 weeks.** Phase 1: importer + paste UI + sanity tests. Phase 2: agent migration on top of Phase 1.
- **Pre-release rule applies.** Per CLAUDE.md "No backward compatibility. Ever." — the old `insertNode` / `insertTree` tool surface is deleted in Phase 2, not deprecated. The recursive `InsertTreeNodeSchema` and its hand-walking executor disappear.

---

## Why this is a plan

Two specific things in the current system make this work worth doing now, not later.

### 1. Pasting HTML today produces nothing

There is no path from "I have an HTML snippet" to "I have an editable section in the canvas". The user can hand-build the same section via the module picker, but it takes minutes for what is seconds of paste. Designers comping in Webflow / Figma plugins / Tailwind UI / ChatGPT routinely produce HTML they want to bring in.

### 2. The AI fights its own toolset

Today's agent shape, from `server/ai/tools/site/writeTools.ts`:

```jsonc
// insertTree({ parentId, classes, tree })
{
  "parentId": "nd_root",
  "classes": [{ "name": "hero-section", "styles": { "paddingInline": "24px", … } }],
  "tree": {
    "moduleId": "base.container",
    "props": { "tag": "section" },
    "classIds": ["hero-section"],
    "children": [
      { "moduleId": "base.text", "props": { "tag": "h1", "text": "Welcome" } }
    ]
  }
}
```

The agent has to know:
- 12 base module IDs in `base.xxx-yyy` format (and not invent `LayoutContainer` or `HeroSection`).
- Per-module prop names (`text` + `tag` on `base.text`, `label` + `href` on `base.button`, `customTag` for non-standard tags on `base.container`).
- camelCase CSS keys (`paddingInline`, `gridTemplateColumns`) vs the kebab-case it sees everywhere else.
- The `breakpointOverridable` rule for which props you can vary per breakpoint.

LLMs are dramatically better at writing HTML than at producing structured tool calls with our specific module IDs and prop names. The training distribution is overwhelmingly HTML; this custom JSON shape is a small island. The current system prompt (`server/ai/tools/site/systemPrompt.ts`) even forbids the agent from writing HTML in chat replies — because it has to produce JSON tool calls instead, and we don't want it confusing the two surfaces.

Once the HTML importer exists, the agent's job becomes: "write HTML for structure, call the existing class tools for styles." Native habitat. Shorter prompt. Fewer wrong shapes.

### What we leverage

| Concern                            | Lives in                                              | Already does                                                  |
|------------------------------------|-------------------------------------------------------|---------------------------------------------------------------|
| Catch-all tag handling             | `base.container.customTag` prop                       | Renders any element name the user puts in `customTag`         |
| Class assignment                   | `PageNode.classIds`                                   | Class identities resolve at publish; identity-only at import  |
| Subtree-to-HTML rendering          | `renderNode` in `src/core/publisher/renderNode.ts`    | The reverse direction; reused by `getNodeHtml`                |
| HTML-escape boundary               | `escapeProps` in `src/core/publisher/escapeProps.ts`  | Unchanged — the importer produces props that are escape-clean |
| Browser-side DOM parsing           | `DOMParser`                                           | Available in every iframe / editor context                    |
| Server-side DOM parsing            | `happy-dom`                                           | Already installed for richtext sanitization                   |
| Existing class tools               | `createClass` / `updateClassStyles` / `assignClass`   | Unchanged; agent and humans continue to use them              |

The module engine, the plugin SDK, the page-tree primitive, the publisher, the canvas iframe rendering, the property schema — none of these change. The plan is a focused addition.

---

## Goals and non-goals

### Goals

- One HTML→tree function in `src/core/htmlImport/`, callable from both paste UI and AI tools.
- Every imported element becomes a first-class, editable node — selectable, draggable, deletable, restyleable.
- Class names preserved verbatim on `node.classIds` so external CSS imports later compose cleanly.
- An agent surface where the natural input is HTML, not custom tree JSON.
- A shorter, more honest system prompt: structural rules + class rules + breakpoint rules; no module-ID enumeration.

### Non-goals

- CSS parsing or import of any kind. Pasted `<style>` is stripped; inline `style="…"` is stripped; `@media` queries are stripped. Separate workstream owns external CSS file imports into the class registry.
- Module template editing or forking. The `render()` contract stays exactly as today. Modules are still hand-written TypeScript.
- A round-trip fidelity guarantee on arbitrary HTML. The mapping is approximate by construction — the iframe renders whatever HTML the resulting tree emits, which is the same HTML the publisher would emit for those modules. Sanity tests gate the mapping; no fixture-based round-trip suite.
- First-class form / table / input modules in this plan. Today they import as `base.container` with `customTag`, which renders correctly. If real usage demands first-class modules, add them as follow-on work — the importer picks them up automatically once the mapping rule is added.
- Backward compatibility with `insertNode` / `insertTree`. Pre-release. They're deleted in Phase 2.

---

## What the user sees

### Pasting HTML into the canvas

Spotlight → "Import HTML" → modal:

```text
┌──────────────────────────────────────────────────────────────┐
│ Import HTML                                            ✕    │
├──────────────────────────────────────────────────────────────┤
│ Paste HTML                                                   │
│ ┌────────────────────────────────────────────────────────┐  │
│ │ <section class="hero">                                 │  │
│ │   <h1>Welcome to the future</h1>                       │  │
│ │   <p>A subtitle for the hero section.</p>              │  │
│ │   <a class="btn" href="/start">Get started</a>         │  │
│ │ </section>                                             │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                              │
│ Insert into:  [ Page root (Home)              ▼ ]            │
│                                                              │
│ Preview (4 nodes)                                            │
│ ▾ base.container  (tag: section, class: hero)                │
│   • base.text     (tag: h1, "Welcome to the future")         │
│   • base.text     (tag: p,  "A subtitle for the hero…")      │
│   • base.button   (label: "Get started", href: "/start")     │
│                                                              │
│                                          [Cancel]  [Insert] │
└──────────────────────────────────────────────────────────────┘
```

Right-click any container node in the canvas → "Paste HTML here…" pre-fills the modal with the clipboard contents and pre-selects that container as the insertion parent.

After insert: real nodes appear in the page tree. The user can select, drag, delete, restyle each one through the standard editor mutations. Class names are on each node's `classIds` — when the external-CSS-import workstream lands, importing the matching `.css` file will resolve those classes into editor-aware `StyleRule` entries.

### What the agent does after Phase 2

Today: the agent must enumerate module IDs and prop names. After Phase 2:

```text
User: "Add a pricing section with three plans."

Agent calls:
  1. createClass({ name: "pricing-grid", styles: { display: "grid",
       gridTemplateColumns: "repeat(3, 1fr)", gap: "24px" },
       breakpointStyles: { mobile: { gridTemplateColumns: "1fr" } } })
  2. createClass({ name: "pricing-card", styles: { padding: "24px",
       borderRadius: "12px", border: "1px solid #e5e7eb" } })
  3. insertHtml({
       parentId: "nd_root",
       html: `
         <section class="pricing-grid">
           <article class="pricing-card">
             <h3>Starter</h3>
             <p>$9/mo</p>
             <button>Choose plan</button>
           </article>
           <article class="pricing-card">
             <h3>Pro</h3>
             <p>$29/mo</p>
             <button>Choose plan</button>
           </article>
           <article class="pricing-card">
             <h3>Enterprise</h3>
             <p>Contact us</p>
             <button>Choose plan</button>
           </article>
         </section>
       `
     })

Agent reply (1-2 sentences): "Added a 3-column pricing grid that collapses to 1 column on mobile."
```

Same number of round-trips. Different shape. No module-ID enumeration in the prompt; no per-module prop-name memorisation; styling stays in the existing class tools.

---

## The importer pipeline

```text
input HTML (string)  ──▶  parseHtml (DOMParser browser / happy-dom server)
                              │
                              ▼
                          DOM tree
                              │
                              ▼
                  walkAndMap (per-element rules)
                              │
                              ▼
                      PageNode[]
                              │
                              ▼
              applyToTree(insertLocation, nodes)
```

CSS is not parsed. Class names from `el.classList` are preserved verbatim onto `node.classIds`; that's it. External CSS file imports are a separate workstream that will hydrate the class registry with the matching `StyleRule` entries; the two operations compose because class identities are preserved through both.

### The mapping table

Declarative; additive; new rules are cheap to add.

```ts
const HTML_TO_MODULE_RULES: ImportRule[] = [
  // Headings, paragraphs, inline phrasing → base.text with the right tag
  { match: 'h1, h2, h3, h4, h5, h6, p, span, small, strong, em',
    map: (el) => ({ moduleId: 'base.text', props: { text: el.textContent ?? '', tag: el.tagName.toLowerCase() } }) },

  // Links → base.link OR base.button (button-classed)
  { match: 'a',
    map: (el) => ({
      moduleId: el.classList.contains('btn') ? 'base.button' : 'base.link',
      props: { label: el.textContent ?? '', href: el.getAttribute('href') ?? '', target: el.getAttribute('target') ?? '_self' },
    }) },

  // Images
  { match: 'img',
    map: (el) => ({ moduleId: 'base.image', props: { src: el.getAttribute('src') ?? '', alt: el.getAttribute('alt') ?? '' } }) },

  // Lists
  { match: 'ul, ol',
    map: (el) => ({ moduleId: 'base.list', props: { tag: el.tagName.toLowerCase() } }), recurse: true },

  // Buttons
  { match: 'button',
    map: (el) => ({ moduleId: 'base.button', props: { label: el.textContent ?? '', disabled: el.hasAttribute('disabled') } }) },

  // Generic semantic containers
  { match: 'div, section, article, header, footer, main, nav, aside, figure, blockquote',
    map: (el) => ({ moduleId: 'base.container', props: { tag: el.tagName.toLowerCase() } }), recurse: true },

  // Fallback for any other element tag (form, table, dl, hr, input, …)
  { match: '*',
    map: (el) => ({ moduleId: 'base.container', props: { tag: 'div', customTag: el.tagName.toLowerCase() } }), recurse: true },
]
```

Three properties of this design:

1. **There's always a match.** The catch-all maps any element tag the table didn't handle explicitly into `base.container` with `customTag` set to the original tag name. `base.container` already supports arbitrary tag names — that's how the editor handles non-standard HTML today. No element ever falls through.
2. **Class names are preserved.** Every node receives `classIds: [...el.classList]` regardless of which module the element mapped to. This is the join point with the future external CSS imports.
3. **Children recurse by default.** Container-shaped rules recurse; leaf-shaped rules (text, image, button) don't. The user can promote / split nodes later via the standard editor mutations.

### What gets dropped at import

| Construct                                  | Treatment                                                              |
|--------------------------------------------|------------------------------------------------------------------------|
| `<script>` tags                            | Dropped (consistent with publisher sanitize)                           |
| Inline event handlers (`onclick=`, etc.)   | Dropped                                                                |
| `<style>` blocks                           | Dropped (CSS is out of scope for this work)                            |
| Inline `style="…"` attributes              | Dropped                                                                |
| `@import`, `url()` inside `<style>`        | Dropped with the `<style>` block                                       |
| Comments, processing instructions          | Dropped                                                                |

A small toast notification surfaces a count when anything is dropped: "Imported 12 nodes. Stripped: 1 `<style>` block, 2 inline event handlers." Non-blocking; informational.

### What gets lossy

The mapping is approximate by design. Two narrow cases where information genuinely doesn't survive:

- **HTML attributes not modelled in the matched module's schema** — e.g. `<a download="report.pdf">` matches `base.link`, which has no `download` prop. The attribute is dropped at import. (Fix path: extend the module's schema; the importer picks the new attribute up automatically once the rule references it.)
- **Self-closing / void elements with semantics that don't fit `base.container`** — `<input>`, `<br>`, `<hr>` etc. import as `base.container` with `customTag`. Semantically fine, structurally fine; the iframe renders them correctly because `base.container` emits exactly the markup it was given. If users routinely paste these and want first-class modules, add them later.

### Test bar

A single sanity-test file: `src/__tests__/htmlImport/mapping.test.ts`. Per-rule unit tests (~5–10 small hand-written snippets per rule):

- "an `<h1>` becomes a `base.text` with `tag: 'h1'` and the right text content"
- "an `<a class='btn'>` matches `base.button`, not `base.link`"
- "an unknown tag like `<dialog>` falls through to `base.container` with `customTag: 'dialog'`"
- "a `<script>` is stripped"
- "class names from `class='foo bar'` become `classIds: ['foo', 'bar']`"

Pure unit tests, no round-trip pipeline. If a real pasted snippet produces a surprising tree, the fix is to add a rule, not to file a bug against a fixture suite.

---

## Agent migration to HTML-native (Phase 2)

The agent's tool surface shrinks and its capability grows. Same number of tools registered (16 today, 17 after — net +1), but the structural-insertion tools are uniform and the system prompt drops everything it previously had to enumerate.

### Three new tools

Added to `server/ai/tools/site/writeTools.ts`:

```ts
insertHtml({
  parentId: string,
  index?: number,
  html: string,                        // run through walkAndMap → tree nodes
  classes?: ClassDefinition[],         // declared atomically before insertion; same shape as today's insertTree.classes
}): { nodeIds: string[] }              // ids of the inserted root nodes

getNodeHtml({
  nodeId: string,
}): { html: string }                   // publisher.renderNode(nodeId) — the exact HTML the published page would emit for this subtree

replaceNodeHtml({
  nodeId: string,
  html: string,                        // walkAndMap output replaces the subtree's children
  classes?: ClassDefinition[],
}): { nodeIds: string[] }              // ids of the new root nodes (the target node itself is preserved as parent)
```

- `insertHtml` reuses Phase 1's importer verbatim. The optional `classes` array means the agent can declare class styles and insert structure atomically — same pattern as today's `insertTree`.
- `getNodeHtml` reuses the publisher's existing `renderNode` walker. No new rendering path; a thin handler that returns the rendered HTML for a subtree.
- `replaceNodeHtml` closes the loop: the agent reads HTML for a section, edits it, posts it back, and the importer rebuilds the subtree.

### Two tools deleted

- `insertNode` — replaced by `insertHtml` with a single-element HTML string.
- `insertTree` — replaced by `insertHtml`. The recursive `InsertTreeNodeSchema` and its hand-walking executor logic in `src/admin/pages/site/agent/executor.ts` disappear entirely.

### Tools unchanged

- Node surgical edits: `updateNodeProps`, `moveNode`, `deleteNode`, `duplicateNode`, `renameNode`
- Class management: `createClass`, `updateClassStyles`, `assignClass`, `removeClass`
- Page management: `addPage`, `deletePage`, `renamePage`, `duplicatePage`
- Capture: `render_snapshot`

### System prompt rewrite

`server/ai/tools/site/systemPrompt.ts` static prefix gets shortened. Remove:

- The module-ID enumeration block (`base.container`, `base.body`, `base.text`, …). The agent writes semantic HTML; it doesn't need to know module IDs.
- The per-module prop-name guidance. The importer's mapping rules pick the right module from the element's tag.

Add a single rule:

> **Structure as HTML, styling as classes.** Insert structure with `insertHtml` using semantic HTML (`<section>`, `<h1>`, `<a>`, `<button>`, `<img>`, …). For styling, call `createClass` and reference the class name from your HTML's `class=` attributes. `<style>` blocks and `style=` attributes in HTML are stripped at import — they have no effect. For per-breakpoint variation, use `createClass({ breakpointStyles })` keyed by the breakpoint IDs in the dynamic suffix — verbatim only.

Keep:

- The breakpoint-IDs-verbatim rule.
- The "no raw HTML/CSS in chat reply — narrate only" rule. HTML belongs in tool calls, not in conversation.
- All page-management rules.

Net result: a static prefix roughly half the current length.

### CSS in agent-supplied HTML

Same rules as paste-import — that's the point of unifying. `<style>` stripped, `style=` stripped, `@media` impossible (it lives inside `<style>`), `<script>` stripped. The agent declares styles via `createClass` / `updateClassStyles`; responsive variation via `breakpointStyles`.

### Architecture tests

- `agent-tool-surface.test.ts` (new) — gates the registered tool list. Asserts `insertNode` and `insertTree` are absent; `insertHtml`, `getNodeHtml`, `replaceNodeHtml` are present.
- `agent-system-prompt-no-module-enumeration.test.ts` (new) — gates against re-introducing a module-ID list in the static prompt prefix. Simple textual scan for `base.container` / `base.text` etc.
- `agent-no-raw-html-in-reply-rule.test.ts` (new) — gates that the "narrate only, no raw HTML in chat" rule survives prompt rewrites. Textual check for the rule's keyword phrase.

---

## Decisions

These were settled during spec review and are binding for the implementation phases.

1. **HTML import shape.** Full structural tree — every parsed element becomes a first-class node. No "raw HTML blob" fallback. The catch-all rule maps unrecognised tags to `base.container` with `customTag`.
2. **CSS handling at import.** Out of scope. The importer preserves class names on nodes but does not parse, attach, or migrate any CSS. External CSS file imports are a separate workstream; the two paths compose because class names are preserved through both.
3. **Test bar.** Per-rule unit tests in `src/__tests__/htmlImport/mapping.test.ts`. No round-trip fixture suite. If a pasted snippet produces a surprising tree, the fix is a new rule.
4. **Agent tool surface.** `insertNode` and `insertTree` deleted; replaced by `insertHtml`, `getNodeHtml`, `replaceNodeHtml`. Same shape pasted HTML uses.
5. **Agent responsive styling.** Stays in the class tools (`createClass({ breakpointStyles })`). The HTML import pipeline never handles `@media`.

---

## Phases

### Phase 1 — HTML → canvas importer

- `src/core/htmlImport/` — new module:
  - `parseHtml(source: string): Document` — `DOMParser` in the browser, `happy-dom` on the server.
  - `walkAndMap(doc: Document): PageNode[]` — the walker, driven by `HTML_TO_MODULE_RULES`.
  - `HTML_TO_MODULE_RULES` — the declarative table above.
  - `stripUnsafe(doc)` — removes `<script>`, `<style>`, inline event handlers, inline `style=`. Returns a count for the toast.
- Class names from `el.classList` carried through onto `node.classIds`. No CSS parsing.
- Spotlight command: "Import HTML" (registered through the existing Spotlight command catalog).
- Page menu action: "Paste HTML here…" on container nodes — pre-fills modal with clipboard contents and pre-selects the parent.
- Modal UI: HTML textarea + insertion-parent picker + preview tree → Insert button. Non-blocking strip-count toast on success.
- Sanity tests: `src/__tests__/htmlImport/mapping.test.ts` — per-rule unit tests (~5–10 snippets each).
- Docs: new `docs/features/html-import.md` (~150 lines); cross-link from `docs/features/modules.md`.
- Effort: ~1–1.5 weeks.

### Phase 2 — agent goes HTML-native

- `server/ai/tools/site/writeTools.ts` — add `insertHtml`, `getNodeHtml`, `replaceNodeHtml`. Delete `insertNode` and `insertTree`.
- `src/admin/pages/site/agent/executor.ts` — delete the recursive `InsertTreeNodeSchema` and the `runInsertTree` / `insertTreeNode` functions. Add a thin handler that calls Phase 1's `walkAndMap` and dispatches the resulting nodes through the existing single-node `insertNode` store action (or its replacement; the store-side mutation is independent of the tool surface).
- `server/ai/tools/site/systemPrompt.ts` — rewrite the static prefix. Remove module-ID enumeration; remove per-module prop guidance; add the "structure as HTML, styling as classes" rule.
- Architecture tests: `agent-tool-surface.test.ts`, `agent-system-prompt-no-module-enumeration.test.ts`, `agent-no-raw-html-in-reply-rule.test.ts` (all new).
- Docs: rewrite `docs/features/agent.md` to reflect the HTML-native surface. Cross-link from `docs/features/html-import.md`: "The same importer powers the AI's `insertHtml` tool."
- Effort: ~3–5 days. Most of the time is system-prompt iteration — testing the new prompt against ~10 representative build-a-section prompts and tightening rules where the agent gets sloppy.

---

## Scope estimate

For a single engineer working full-time:

| Phase | Effort        | Risk         |
|-------|---------------|--------------|
| 1     | 1–1.5 weeks   | Low. The mapping table is a small declarative file; the catch-all rule guarantees no falls-through; the iframe renders whatever HTML the resulting tree emits. Per-rule sanity tests are the only gate. |
| 2     | 3–5 days      | Low–medium. Tool plumbing is mechanical (the importer already exists from Phase 1). The variable cost is system-prompt iteration. |
| **Total** | **~2–2.5 weeks** | |

Phases 1 and 2 can be developed sequentially in the same two-week block. Phase 2 is strictly dependent on Phase 1.

---

## Out of scope (explicit non-goals for this plan)

This plan deliberately does NOT include:

- **CSS parsing or import of any kind.** Pasted HTML's class names are preserved on `node.classIds`, but the importer never touches CSS — no class-registry insertions, no imported stylesheets, no inline-style promotion, no `@media` handling. A separate workstream will import external CSS files into the class registry; the two import paths compose because class identities are preserved through both.
- **Module template editing or forking.** The `render()` contract stays exactly as today. Modules are still hand-written TypeScript. (A separate plan can revisit this; it is not coupled to the HTML pipeline.)
- **Bytewise round-trip verification of HTML import.** The mapping is approximate by design. The catch-all rule (`base.container` with `customTag`) guarantees no element falls through; sanity tests cover each rule's intended behaviour.
- **First-class form / table / input modules.** Today these elements import as `base.container` with `customTag`, which is correct enough — the iframe renders them, the editor selects them, the user can style them. If real usage shows demand, add them as dedicated mapping rules later.

Handled inside this plan:

- **JavaScript in pasted or agent-supplied HTML.** `<script>` tags and inline event handlers stripped at import. Consistent with the publisher's existing rule that scripts in module HTML are stripped at publish-time sanitize.
- **HTML that references CMS concepts (VC refs, loops, slot constructs).** Impossible by construction — those are tree-level concepts, not HTML — so the importer never produces those node kinds.
- **Class-name collisions with existing StyleRule registry entries.** Because the importer doesn't touch the class registry, no collision is possible. A pasted `.hero` class name on a node, plus a later-imported `.hero` CSS rule, simply line up — by design.

---

## Related

- [docs/features/modules.md](../features/modules.md) — module engine (unchanged by this plan; `base.container.customTag` is the relevant prop for arbitrary HTML tags)
- [docs/features/publisher.md](../features/publisher.md) — `renderNode` is reused by `getNodeHtml`
- [docs/features/agent.md](../features/agent.md) — agent integration (rewritten by Phase 2)
- [docs/reference/page-tree.md](../reference/page-tree.md) — `NodeTree<PageNode>` (unchanged)
- [docs/reference/css-class-registry.md](../reference/css-class-registry.md) — author-class CSS (untouched by this plan; the future external-CSS-import workstream will write to this registry)
- [docs/reference/typebox-patterns.md](../reference/typebox-patterns.md) — boundary validation for the new tool input schemas
- Source-of-truth files to be touched:
  - `src/core/htmlImport/` (new module — parseHtml, walkAndMap, HTML_TO_MODULE_RULES, stripUnsafe)
  - `src/admin/pages/site/` (new "Import HTML" Spotlight command + page-context "Paste HTML here…" action + modal UI)
  - `src/__tests__/htmlImport/mapping.test.ts` (new — per-rule sanity tests)
  - `server/ai/tools/site/writeTools.ts` (Phase 2 — `insertNode` / `insertTree` deleted, `insertHtml` / `getNodeHtml` / `replaceNodeHtml` added)
  - `server/ai/tools/site/systemPrompt.ts` (Phase 2 — module-ID enumeration removed)
  - `src/admin/pages/site/agent/executor.ts` (Phase 2 — recursive InsertTreeNode walker deleted)
  - `src/__tests__/architecture/agent-tool-surface.test.ts` (new)
  - `src/__tests__/architecture/agent-system-prompt-no-module-enumeration.test.ts` (new)
  - `src/__tests__/architecture/agent-no-raw-html-in-reply-rule.test.ts` (new)
  - `docs/features/html-import.md` (new — small)
  - `docs/features/agent.md` (rewritten by Phase 2)
