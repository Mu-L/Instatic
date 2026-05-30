/**
 * Typed api-call schemas — maps every `AllowedApiTarget` to its validated
 * request shape (TypeBox), and exports `Static<>` convenience types for
 * callers that need to pattern-match on the narrowed api-call objects.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { StorageListOptionsSchema } from '@core/plugin-sdk/storageSchemas'
import { type AllowedApiTarget } from './targets'
import { RouteRegistrationArgSchema } from './schemas/routes'
import { HookListenerArgSchema, HookFilterArgSchema, HookEmitArgSchema } from './schemas/hooks'
import { LoopSourceDescriptorSchema } from './schemas/loops'
import { JsonRecordSchema } from './schemas/storage'
import { NetworkFetchInitSchema, NetworkAbortArgSchema } from './schemas/network'
import { ScheduleRegisterArgSchema, ScheduleCancelArgSchema } from './schemas/schedule'
import {
  RegisterStorageAdapterArgSchema,
  RegisterUrlTransformerArgSchema,
  RegisterVariantDelegateArgSchema,
} from './schemas/media'
import { CryptoDigestArgSchema, CryptoSignHmacArgSchema } from './schemas/crypto'
import {
  ContentEntriesCreateArgsSchema,
  ContentEntriesCreateManyArgsSchema,
  ContentEntriesDeleteArgsSchema,
  ContentEntriesDeleteManyArgsSchema,
  ContentEntriesGetArgsSchema,
  ContentEntriesGetBySlugArgsSchema,
  ContentEntriesListArgsSchema,
  ContentEntriesMoveTableArgsSchema,
  ContentEntriesPublishArgsSchema,
  ContentEntriesUpdateArgsSchema,
  ContentEntriesUpdateManyArgsSchema,
  ContentRepublishAllArgsSchema,
  ContentSearchArgsSchema,
  ContentSnapshotArgsSchema,
  ContentTablesCreateArgsSchema,
  ContentTablesGetArgsSchema,
  ContentTablesListArgsSchema,
  ContentTreeMutateArgsSchema,
  ContentTreeReadArgsSchema,
  ContentTreeReplaceArgsSchema,
} from './schemas/content'

// ---------------------------------------------------------------------------
// Generic schema builder
// ---------------------------------------------------------------------------

export function apiCallSchema<TTarget extends AllowedApiTarget, TArgs extends TSchema>(
  target: TTarget,
  args: TArgs,
) {
  return Type.Object(
    {
      kind: Type.Literal('api-call'),
      correlationId: Type.String({ minLength: 1 }),
      pluginId: Type.String({ minLength: 1 }),
      target: Type.Literal(target),
      args,
    },
    { additionalProperties: false },
  )
}

// ---------------------------------------------------------------------------
// Per-target schemas
// ---------------------------------------------------------------------------

export const ApiCallSchemas = {
  'cms.routes.register': apiCallSchema('cms.routes.register', Type.Tuple([RouteRegistrationArgSchema])),
  'cms.hooks.on': apiCallSchema('cms.hooks.on', Type.Tuple([HookListenerArgSchema])),
  'cms.hooks.filter': apiCallSchema('cms.hooks.filter', Type.Tuple([HookFilterArgSchema])),
  'cms.hooks.emit': apiCallSchema('cms.hooks.emit', Type.Tuple([HookEmitArgSchema])),
  'cms.loops.registerSource': apiCallSchema('cms.loops.registerSource', Type.Tuple([LoopSourceDescriptorSchema])),
  'cms.storage.list': apiCallSchema('cms.storage.list', Type.Tuple([
    Type.String({ minLength: 1 }),
    StorageListOptionsSchema,
  ])),
  'cms.storage.create': apiCallSchema('cms.storage.create', Type.Tuple([Type.String({ minLength: 1 }), JsonRecordSchema])),
  'cms.storage.update': apiCallSchema('cms.storage.update', Type.Tuple([
    Type.String({ minLength: 1 }),
    Type.String({ minLength: 1 }),
    JsonRecordSchema,
  ])),
  'cms.storage.delete': apiCallSchema('cms.storage.delete', Type.Tuple([
    Type.String({ minLength: 1 }),
    Type.String({ minLength: 1 }),
  ])),
  'cms.settings.replace': apiCallSchema('cms.settings.replace', Type.Tuple([JsonRecordSchema])),
  'network.fetch': apiCallSchema('network.fetch', Type.Tuple([
    Type.String({ minLength: 1, maxLength: 2048 }),
    NetworkFetchInitSchema,
  ])),
  // The host is intentionally permissive about `network.abort` — it does
  // NOT require `network.outbound` to be granted. A plugin without the
  // permission can never have minted a live `abortId` in the first place,
  // so the worst case is a missed lookup that no-ops (see dispatchApiCall).
  'network.abort': apiCallSchema('network.abort', Type.Tuple([NetworkAbortArgSchema])),
  'cms.schedule.register': apiCallSchema('cms.schedule.register', Type.Tuple([ScheduleRegisterArgSchema])),
  'cms.schedule.cancel': apiCallSchema('cms.schedule.cancel', Type.Tuple([ScheduleCancelArgSchema])),
  'cms.media.registerStorageAdapter': apiCallSchema(
    'cms.media.registerStorageAdapter',
    Type.Tuple([RegisterStorageAdapterArgSchema]),
  ),
  'cms.media.registerUrlTransformer': apiCallSchema(
    'cms.media.registerUrlTransformer',
    Type.Tuple([RegisterUrlTransformerArgSchema]),
  ),
  'cms.media.registerVariantDelegate': apiCallSchema(
    'cms.media.registerVariantDelegate',
    Type.Tuple([RegisterVariantDelegateArgSchema]),
  ),
  'cms.content.tables.list': apiCallSchema('cms.content.tables.list', ContentTablesListArgsSchema),
  'cms.content.tables.get': apiCallSchema('cms.content.tables.get', ContentTablesGetArgsSchema),
  'cms.content.tables.create': apiCallSchema('cms.content.tables.create', ContentTablesCreateArgsSchema),
  'cms.content.entries.list': apiCallSchema('cms.content.entries.list', ContentEntriesListArgsSchema),
  'cms.content.entries.get': apiCallSchema('cms.content.entries.get', ContentEntriesGetArgsSchema),
  'cms.content.entries.getBySlug': apiCallSchema('cms.content.entries.getBySlug', ContentEntriesGetBySlugArgsSchema),
  'cms.content.entries.create': apiCallSchema('cms.content.entries.create', ContentEntriesCreateArgsSchema),
  'cms.content.entries.update': apiCallSchema('cms.content.entries.update', ContentEntriesUpdateArgsSchema),
  'cms.content.entries.delete': apiCallSchema('cms.content.entries.delete', ContentEntriesDeleteArgsSchema),
  'cms.content.entries.publish': apiCallSchema('cms.content.entries.publish', ContentEntriesPublishArgsSchema),
  'cms.content.entries.moveTable': apiCallSchema('cms.content.entries.moveTable', ContentEntriesMoveTableArgsSchema),
  'cms.content.entries.createMany': apiCallSchema('cms.content.entries.createMany', ContentEntriesCreateManyArgsSchema),
  'cms.content.entries.updateMany': apiCallSchema('cms.content.entries.updateMany', ContentEntriesUpdateManyArgsSchema),
  'cms.content.entries.deleteMany': apiCallSchema('cms.content.entries.deleteMany', ContentEntriesDeleteManyArgsSchema),
  'cms.content.tree.read': apiCallSchema('cms.content.tree.read', ContentTreeReadArgsSchema),
  'cms.content.tree.mutate': apiCallSchema('cms.content.tree.mutate', ContentTreeMutateArgsSchema),
  'cms.content.tree.replace': apiCallSchema('cms.content.tree.replace', ContentTreeReplaceArgsSchema),
  'cms.content.search': apiCallSchema('cms.content.search', ContentSearchArgsSchema),
  'cms.content.snapshot': apiCallSchema('cms.content.snapshot', ContentSnapshotArgsSchema),
  'cms.content.republishAll': apiCallSchema('cms.content.republishAll', ContentRepublishAllArgsSchema),
  'crypto.digest': apiCallSchema('crypto.digest', Type.Tuple([CryptoDigestArgSchema])),
  'crypto.signHmac': apiCallSchema('crypto.signHmac', Type.Tuple([CryptoSignHmacArgSchema])),
} satisfies Record<AllowedApiTarget, TSchema>

// ---------------------------------------------------------------------------
// Static types per target
// ---------------------------------------------------------------------------

export type RouteRegistrationApiCall = Static<typeof ApiCallSchemas['cms.routes.register']>
export type HookOnApiCall = Static<typeof ApiCallSchemas['cms.hooks.on']>
export type HookFilterApiCall = Static<typeof ApiCallSchemas['cms.hooks.filter']>
export type HookEmitApiCall = Static<typeof ApiCallSchemas['cms.hooks.emit']>
export type LoopSourceRegisterApiCall = Static<typeof ApiCallSchemas['cms.loops.registerSource']>
export type StorageListApiCall = Static<typeof ApiCallSchemas['cms.storage.list']>
export type StorageCreateApiCall = Static<typeof ApiCallSchemas['cms.storage.create']>
export type StorageUpdateApiCall = Static<typeof ApiCallSchemas['cms.storage.update']>
export type StorageDeleteApiCall = Static<typeof ApiCallSchemas['cms.storage.delete']>
export type SettingsReplaceApiCall = Static<typeof ApiCallSchemas['cms.settings.replace']>
export type NetworkFetchApiCall = Static<typeof ApiCallSchemas['network.fetch']>
export type NetworkAbortApiCall = Static<typeof ApiCallSchemas['network.abort']>
export type ScheduleRegisterApiCall = Static<typeof ApiCallSchemas['cms.schedule.register']>
export type ScheduleCancelApiCall = Static<typeof ApiCallSchemas['cms.schedule.cancel']>
export type RegisterStorageAdapterApiCall = Static<typeof ApiCallSchemas['cms.media.registerStorageAdapter']>
export type RegisterUrlTransformerApiCall = Static<typeof ApiCallSchemas['cms.media.registerUrlTransformer']>
export type RegisterVariantDelegateApiCall = Static<typeof ApiCallSchemas['cms.media.registerVariantDelegate']>
export type CryptoDigestApiCall = Static<typeof ApiCallSchemas['crypto.digest']>
export type CryptoSignHmacApiCall = Static<typeof ApiCallSchemas['crypto.signHmac']>
export type ContentTablesListApiCall = Static<typeof ApiCallSchemas['cms.content.tables.list']>
export type ContentTablesGetApiCall = Static<typeof ApiCallSchemas['cms.content.tables.get']>
export type ContentTablesCreateApiCall = Static<typeof ApiCallSchemas['cms.content.tables.create']>
export type ContentEntriesListApiCall = Static<typeof ApiCallSchemas['cms.content.entries.list']>
export type ContentEntriesGetApiCall = Static<typeof ApiCallSchemas['cms.content.entries.get']>
export type ContentEntriesGetBySlugApiCall = Static<typeof ApiCallSchemas['cms.content.entries.getBySlug']>
export type ContentEntriesCreateApiCall = Static<typeof ApiCallSchemas['cms.content.entries.create']>
export type ContentEntriesUpdateApiCall = Static<typeof ApiCallSchemas['cms.content.entries.update']>
export type ContentEntriesDeleteApiCall = Static<typeof ApiCallSchemas['cms.content.entries.delete']>
export type ContentEntriesPublishApiCall = Static<typeof ApiCallSchemas['cms.content.entries.publish']>
export type ContentEntriesMoveTableApiCall = Static<typeof ApiCallSchemas['cms.content.entries.moveTable']>
export type ContentEntriesCreateManyApiCall = Static<typeof ApiCallSchemas['cms.content.entries.createMany']>
export type ContentEntriesUpdateManyApiCall = Static<typeof ApiCallSchemas['cms.content.entries.updateMany']>
export type ContentEntriesDeleteManyApiCall = Static<typeof ApiCallSchemas['cms.content.entries.deleteMany']>
export type ContentTreeReadApiCall = Static<typeof ApiCallSchemas['cms.content.tree.read']>
export type ContentTreeMutateApiCall = Static<typeof ApiCallSchemas['cms.content.tree.mutate']>
export type ContentTreeReplaceApiCall = Static<typeof ApiCallSchemas['cms.content.tree.replace']>
export type ContentSearchApiCall = Static<typeof ApiCallSchemas['cms.content.search']>
export type ContentSnapshotApiCall = Static<typeof ApiCallSchemas['cms.content.snapshot']>
export type ContentRepublishAllApiCall = Static<typeof ApiCallSchemas['cms.content.republishAll']>

export type ValidatedApiCall =
  | RouteRegistrationApiCall
  | HookOnApiCall
  | HookFilterApiCall
  | HookEmitApiCall
  | LoopSourceRegisterApiCall
  | StorageListApiCall
  | StorageCreateApiCall
  | StorageUpdateApiCall
  | StorageDeleteApiCall
  | SettingsReplaceApiCall
  | NetworkFetchApiCall
  | NetworkAbortApiCall
  | ScheduleRegisterApiCall
  | ScheduleCancelApiCall
  | RegisterStorageAdapterApiCall
  | RegisterUrlTransformerApiCall
  | RegisterVariantDelegateApiCall
  | CryptoDigestApiCall
  | CryptoSignHmacApiCall
  | ContentTablesListApiCall
  | ContentTablesGetApiCall
  | ContentTablesCreateApiCall
  | ContentEntriesListApiCall
  | ContentEntriesGetApiCall
  | ContentEntriesGetBySlugApiCall
  | ContentEntriesCreateApiCall
  | ContentEntriesUpdateApiCall
  | ContentEntriesDeleteApiCall
  | ContentEntriesPublishApiCall
  | ContentEntriesMoveTableApiCall
  | ContentEntriesCreateManyApiCall
  | ContentEntriesUpdateManyApiCall
  | ContentEntriesDeleteManyApiCall
  | ContentTreeReadApiCall
  | ContentTreeMutateApiCall
  | ContentTreeReplaceApiCall
  | ContentSearchApiCall
  | ContentSnapshotApiCall
  | ContentRepublishAllApiCall
