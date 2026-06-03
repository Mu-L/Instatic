# Font Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build editable font tokens that connect installed fonts to `font-family: var(--font-...)` values in the no-code builder.

**Architecture:** Store installed font assets and builder-facing font tokens together under `site.settings.fonts`. Core font helpers generate `@font-face` rules plus token variables; editor store actions manage token CRUD and variable renames; Typography and Properties panels render rich token pickers.

**Tech Stack:** Bun, TypeScript, TypeBox, Zustand + Immer, React 19, CSS Modules, shared UI primitives.

---

### Task 1: Core Font Token Schema And CSS

**Files:**
- Modify: `src/core/fonts/schemas.ts`
- Modify: `src/core/fonts/css.ts`
- Create: `src/core/fonts/tokens.ts`
- Test: `src/__tests__/fonts/validate.test.ts`
- Test: `src/__tests__/fonts/css.test.ts`

- [ ] **Step 1: Write failing schema and CSS tests**

Add tests that valid font tokens survive validation, malformed tokens are dropped, token variables emit `:root` CSS, fallback-only tokens emit without an installed family, and old installed-family variables are not emitted.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `bun test src/__tests__/fonts/validate.test.ts src/__tests__/fonts/css.test.ts`
Expected: failures for missing `tokens` support and old `--font-<family>` expectations.

- [ ] **Step 3: Implement schema, parser, normalizer, and CSS generation**

Add `FontToken`, tolerant parsing, variable normalization, unique-variable helpers, and CSS generation from `fonts.tokens`.

- [ ] **Step 4: Run focused tests and confirm green**

Run: `bun test src/__tests__/fonts/validate.test.ts src/__tests__/fonts/css.test.ts`
Expected: all tests pass.

### Task 2: Store Actions And Rename Propagation

**Files:**
- Modify: `src/admin/pages/site/store/slices/site/types.ts`
- Modify: `src/admin/pages/site/store/slices/site/fontActions.ts`
- Modify: `src/admin/pages/site/store/slices/site/helpers.ts`
- Test: `src/__tests__/editor-store/fontTokens.test.ts`
- Test: `src/__tests__/editor-store/noOpMutationContract.test.ts`

- [ ] **Step 1: Write failing store tests**

Cover creating tokens, duplicate variable rejection, renaming variables across style rules and inline node styles, changing `familyId` without rewriting style declarations, deleting tokens, no-op mutation behavior, and blocking installed-family removal while a token references it.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `bun test src/__tests__/editor-store/fontTokens.test.ts src/__tests__/editor-store/noOpMutationContract.test.ts`
Expected: failures for missing store actions.

- [ ] **Step 3: Implement font token actions**

Add `createFontToken`, `updateFontToken`, `duplicateFontToken`, `deleteFontToken`, `previewFontTokenDelete`, and update `addFont` / `removeFont` behavior. Variable renames rewrite exact `var(--old)` calls in style rules, context styles, page inline styles, and Visual Component inline styles.

- [ ] **Step 4: Run focused tests and confirm green**

Run: `bun test src/__tests__/editor-store/fontTokens.test.ts src/__tests__/editor-store/noOpMutationContract.test.ts`
Expected: all tests pass.

### Task 3: Property Panel Font Picker

**Files:**
- Create: `src/admin/pages/site/property-controls/FontFamilyControl.tsx`
- Create: `src/admin/pages/site/property-controls/FontFamilyControl.module.css`
- Modify: `src/admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.tsx`
- Test: `src/__tests__/panels/propertiesPanel-redesign.test.tsx`

- [ ] **Step 1: Update failing property-panel expectations**

Add coverage that the `fontFamily` row renders a dedicated picker, selecting a token writes `var(--font-...)`, selecting direct installed font writes a concrete stack, and manual input still works.

- [ ] **Step 2: Run focused test and confirm red**

Run: `bun test src/__tests__/panels/propertiesPanel-redesign.test.tsx`
Expected: failures around the missing dedicated picker.

- [ ] **Step 3: Implement `FontFamilyControl`**

Build a text input with a rich dropdown containing `Inherit`, font tokens, direct installed fonts, and manual value support. Use shared `Input`, `Button`/menu primitives, live font previews, and hover-preview callbacks.

- [ ] **Step 4: Run focused test and confirm green**

Run: `bun test src/__tests__/panels/propertiesPanel-redesign.test.tsx`
Expected: all tests pass or unrelated pre-existing failures are documented.

### Task 4: Typography Fonts Panel UI

**Files:**
- Modify: `src/admin/pages/site/panels/TypographyPanel/FontsSection/FontsSection.tsx`
- Modify: `src/admin/pages/site/panels/TypographyPanel/FontsSection/FontsSection.module.css`
- Create: `src/admin/pages/site/panels/TypographyPanel/FontsSection/FontTokenDialog.tsx`

- [ ] **Step 1: Implement token-first list**

Render font tokens as the primary rows with name, variable, assigned-family preview, fallback, edit/duplicate/delete actions, and one-pixel tile-list styling.

- [ ] **Step 2: Implement token editor dialog**

Create/edit token fields: name, variable, assigned font, fallback. Show live preview through the token's resolved stack and expose variable rename impact copy when editing.

- [ ] **Step 3: Wire install flows**

After installing a new Google/custom family, create a default token for it when no token already references that family. Editing installed font entries should update entries in place and preserve token references.

### Task 5: Import And Docs

**Files:**
- Modify: `src/core/siteImport/types.ts`
- Modify: `src/core/siteImport/adapter.ts`
- Modify: `src/core/siteImport/applyImport.ts`
- Modify: `src/admin/pages/site/store/slices/site/types.ts`
- Modify: `src/admin/pages/site/store/slices/site/helpers.ts`
- Modify: `docs/editor.md`
- Test: `src/__tests__/siteImport/applyImport.test.ts`

- [ ] **Step 1: Add import token transaction support**

Carry imported font tokens through `ImportPlan` and `SiteImportTransaction`, then commit them through the store helper.

- [ ] **Step 2: Update docs**

Document the current font token model in `docs/editor.md`.

### Task 6: Final Verification

- [ ] **Step 1: Run focused architecture/design tests**

Run: `bun test src/__tests__/architecture/css-token-policy.test.ts src/__tests__/architecture/no-css-var-fallbacks.test.ts`

- [ ] **Step 2: Run required project verification**

Run:

```sh
bun run build
bun test
bun run lint
```

- [ ] **Step 3: Run React diagnostics**

Run: `bunx react-doctor@latest --verbose --diff`

- [ ] **Step 4: Browser QA**

Open `http://127.0.0.1:5173/admin/site`, check Typography -> Fonts token rows, property-panel font picker, token rename behavior, and console output.
