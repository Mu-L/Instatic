/**
 * TypeBox schemas for `cms.content.*` api-call arguments.
 *
 * The host validates every cross-VM payload through these schemas before the
 * dispatcher sees it. The schema validation layer is `assertValidApiCall` in
 * `server/plugins/protocol/parser.ts`; per-call shapes are composed via
 * `apiCallSchema` in `server/plugins/protocol/apiCallSchema.ts`.
 *
 * Shapes are intentionally loose at the JSON layer (`Type.Unknown()` for
 * cells / tree nodes) — the host handler does deeper validation against the
 * canonical CMS schemas (`@core/data/schemas`, `@core/page-tree`) so a
 * malformed payload surfaces with a useful host-side error message.
 */

import { Type } from '@sinclair/typebox'
import {
  ContentListOptionsSchema,
  CreateContentEntryInputSchema,
  CreateContentTableInputSchema,
  TreeOperationSchema,
  UpdateContentEntryInputSchema,
} from '@core/plugin-sdk/contentSchemas'

const SlugSchema = Type.String({ minLength: 1 })
const EntryIdSchema = Type.String({ minLength: 1 })
const FieldIdSchema = Type.String({ minLength: 1 })
const QueryStringSchema = Type.String({ minLength: 1, maxLength: 200 })
const PositiveLimit = Type.Integer({ minimum: 1, maximum: 500 })

// ── Tables ──────────────────────────────────────────────────────────────────

export const ContentTablesListArgsSchema = Type.Tuple([])
export const ContentTablesGetArgsSchema = Type.Tuple([SlugSchema])
export const ContentTablesCreateArgsSchema = Type.Tuple([CreateContentTableInputSchema])

// ── Entries ─────────────────────────────────────────────────────────────────

export const ContentEntriesListArgsSchema = Type.Tuple([SlugSchema, ContentListOptionsSchema])
export const ContentEntriesGetArgsSchema = Type.Tuple([SlugSchema, EntryIdSchema])
export const ContentEntriesGetBySlugArgsSchema = Type.Tuple([SlugSchema, SlugSchema])
export const ContentEntriesCreateArgsSchema = Type.Tuple([SlugSchema, CreateContentEntryInputSchema])
export const ContentEntriesUpdateArgsSchema = Type.Tuple([
  SlugSchema,
  EntryIdSchema,
  UpdateContentEntryInputSchema,
])
export const ContentEntriesDeleteArgsSchema = Type.Tuple([SlugSchema, EntryIdSchema])
export const ContentEntriesPublishArgsSchema = Type.Tuple([
  SlugSchema,
  EntryIdSchema,
  Type.Object({
    scheduledFor: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  }, { additionalProperties: false }),
])
export const ContentEntriesMoveTableArgsSchema = Type.Tuple([SlugSchema, EntryIdSchema, SlugSchema])

export const ContentEntriesCreateManyArgsSchema = Type.Tuple([
  SlugSchema,
  Type.Array(CreateContentEntryInputSchema, { maxItems: 500 }),
])
export const ContentEntriesUpdateManyArgsSchema = Type.Tuple([
  SlugSchema,
  Type.Array(
    Type.Object({
      id: EntryIdSchema,
      patch: UpdateContentEntryInputSchema,
    }, { additionalProperties: false }),
    { maxItems: 500 },
  ),
])
export const ContentEntriesDeleteManyArgsSchema = Type.Tuple([
  SlugSchema,
  Type.Array(EntryIdSchema, { maxItems: 500 }),
])

// ── Tree ───────────────────────────────────────────────────────────────────

export const ContentTreeReadArgsSchema = Type.Tuple([EntryIdSchema, FieldIdSchema])
export const ContentTreeMutateArgsSchema = Type.Tuple([
  EntryIdSchema,
  FieldIdSchema,
  Type.Array(TreeOperationSchema, { maxItems: 500 }),
])
export const ContentTreeReplaceArgsSchema = Type.Tuple([
  EntryIdSchema,
  FieldIdSchema,
  Type.Unknown(),
])

// ── Cross-table ────────────────────────────────────────────────────────────

export const ContentSearchArgsSchema = Type.Tuple([QueryStringSchema, PositiveLimit])
export const ContentSnapshotArgsSchema = Type.Tuple([EntryIdSchema])
export const ContentRepublishAllArgsSchema = Type.Tuple([])
