/**
 * Page-tree MCP tools — the headless visual-editing surface.
 *
 * These are ordinary server-resolved `AiTool`s: the MCP registry treats them
 * exactly like the content tools, and the existing `executeAiTool` path runs
 * them (TypeBox input validation + capability re-check + handler dispatch).
 * Each handler rides the shared `treeService`, which dispatches structural
 * operations through the canonical `applyTreeOperation` engine — the same one
 * the visual editor and plugins use.
 *
 * Capability gates mirror the editor's change-class model (structure /
 * content / style) and the HTTP page-edit routes.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { TreeOperationSchema, type TreeOperation } from '@core/page-tree'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../../runtime/types'
import { readPageTree, mutatePageTree } from '../../content/treeService'

// ANY-OF capability sets. Reading needs any site read/edit grant; mutating
// needs any edit grant (plus `ai.tools.write`, enforced by `mutates: true`).
const SITE_READ_CAPS: readonly CoreCapability[] = [
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'pages.edit',
]

const SITE_EDIT_CAPS: readonly CoreCapability[] = [
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'pages.edit',
]

const ReadPageTreeInput = Type.Object(
  {
    entryId: Type.String({ description: 'The page/post entry (data_row) id whose tree to read.' }),
    fieldId: Type.Optional(
      Type.String({ description: 'The pageTree field id. Defaults to "body".' }),
    ),
  },
  { additionalProperties: false },
)

const MutatePageTreeInput = Type.Object(
  {
    entryId: Type.String({ description: 'The page/post entry (data_row) id to edit.' }),
    fieldId: Type.Optional(
      Type.String({ description: 'The pageTree field id. Defaults to "body".' }),
    ),
    operations: Type.Array(TreeOperationSchema, {
      minItems: 1,
      description:
        'Ordered tree operations: insertNode, deleteNode, moveNode, duplicateNode, wrapNode, renameNode, updateNodeProps, setBreakpointOverride, clearBreakpointOverride, toggleNodeLocked, toggleNodeHidden.',
    }),
  },
  { additionalProperties: false },
)

interface ReadInput { entryId: string; fieldId?: string }
interface MutateInput { entryId: string; fieldId?: string; operations: TreeOperation[] }

export const pageTreeMcpTools: AiTool[] = [
  {
    name: 'read_page_tree',
    description:
      "Read a page or post's STRUCTURE as a node tree (JSON: nodes + rootNodeId), by entry id. Headless — works with no editor open. Use for programmatic structure inspection/edits. For the design system as CSS (classes + token variables) use read_styles. To read/author the currently-open document as HTML/CSS, use read_document / insertHtml / applyCss (those need an open editor).",
    scope: 'content',
    execution: 'server',
    inputSchema: ReadPageTreeInput,
    requiredCapabilities: SITE_READ_CAPS,
    handler: async (input, ctx) => {
      const { entryId, fieldId } = input as ReadInput
      return await readPageTree(ctx.db, entryId, fieldId ?? 'body')
    },
  },
  {
    name: 'mutate_page_tree',
    description:
      'Apply structural and property operations to a page tree by entry id — insert, delete, move, duplicate, wrap, rename, update props, breakpoint overrides, lock, hide. Headless (no open editor needed). Returns the updated tree and affected node ids. For HTML/CSS authoring on the open document, use insertHtml / applyCss instead.',
    scope: 'content',
    execution: 'server',
    mutates: true,
    inputSchema: MutatePageTreeInput,
    requiredCapabilities: SITE_EDIT_CAPS,
    handler: async (input, ctx) => {
      const { entryId, fieldId, operations } = input as MutateInput
      return await mutatePageTree(ctx.db, entryId, fieldId ?? 'body', operations, {
        kind: 'user',
        userId: ctx.userId,
      })
    },
  },
]
