/**
 * Inbound api-call dispatch — routes each validated api-call from a plugin
 * worker to the appropriate host-side handler.
 *
 * Every case is a single-line delegate to its named handler function in
 * `handlers/`. The handler is responsible for permission checks, argument
 * coercion, and calling `replyApiOk` or `replyApiError` exactly once.
 * The outer try/catch converts any unhandled throw into a structured error
 * reply so correlation ids are never leaked.
 *
 * SECURITY: Each handler that grants privileged access calls
 * `assertHostPluginPermission` as the kernel-of-correctness check. The
 * VM-side bootstrap performs the same check synchronously (defense-in-depth),
 * but the host check is the authoritative one.
 */

import type { ValidatedApiCall } from '../protocol/apiCallSchema'
import { hostPlugins, getDbForApi } from './registry'
import { replyApiError } from './workerPool'
import { handleRoutesRegister } from './handlers/routes'
import { handleHooksOn, handleHooksFilter, handleHooksEmit } from './handlers/hooks'
import { handleLoopsRegisterSource } from './handlers/loops'
import { handleStorageList, handleStorageCreate, handleStorageUpdate, handleStorageDelete } from './handlers/storage'
import { handleSettingsReplace } from './handlers/settings'
import { handleNetworkFetch, handleNetworkAbort } from './handlers/network'
import { handleScheduleRegister, handleScheduleCancel } from './handlers/schedule'
import { handleMediaRegisterStorageAdapter, handleMediaRegisterUrlTransformer, handleMediaRegisterVariantDelegate } from './handlers/media'
import { handleCryptoDigest, handleCryptoSignHmac } from './handlers/crypto'
import {
  handleContentEntriesCreate,
  handleContentEntriesCreateMany,
  handleContentEntriesDelete,
  handleContentEntriesDeleteMany,
  handleContentEntriesGet,
  handleContentEntriesGetBySlug,
  handleContentEntriesList,
  handleContentEntriesMoveTable,
  handleContentEntriesPublish,
  handleContentEntriesUpdate,
  handleContentEntriesUpdateMany,
  handleContentRepublishAll,
  handleContentSearch,
  handleContentSnapshot,
  handleContentTablesCreate,
  handleContentTablesGet,
  handleContentTablesList,
  handleContentTreeMutate,
  handleContentTreeRead,
  handleContentTreeReplace,
} from './handlers/content'

export async function dispatchApiCall(msg: ValidatedApiCall): Promise<void> {
  const db = getDbForApi()
  if (!db) {
    replyApiError(msg.pluginId, msg.correlationId, 'Plugin worker host has no DbClient configured')
    return
  }
  const entry = hostPlugins.get(msg.pluginId)
  if (!entry) {
    replyApiError(msg.pluginId, msg.correlationId, `Plugin "${msg.pluginId}" is not loaded`)
    return
  }

  try {
    switch (msg.target) {
      case 'cms.routes.register':
        await handleRoutesRegister(msg, entry, db)
        return
      case 'cms.hooks.on':
        await handleHooksOn(msg, entry, db)
        return
      case 'cms.hooks.filter':
        await handleHooksFilter(msg, entry, db)
        return
      case 'cms.hooks.emit':
        await handleHooksEmit(msg, entry, db)
        return
      case 'cms.loops.registerSource':
        await handleLoopsRegisterSource(msg, entry, db)
        return
      case 'cms.storage.list':
        await handleStorageList(msg, entry, db)
        return
      case 'cms.storage.create':
        await handleStorageCreate(msg, entry, db)
        return
      case 'cms.storage.update':
        await handleStorageUpdate(msg, entry, db)
        return
      case 'cms.storage.delete':
        await handleStorageDelete(msg, entry, db)
        return
      case 'cms.settings.replace':
        await handleSettingsReplace(msg, entry, db)
        return
      case 'network.fetch':
        await handleNetworkFetch(msg, entry, db)
        return
      case 'network.abort':
        await handleNetworkAbort(msg, entry, db)
        return
      case 'cms.schedule.register':
        await handleScheduleRegister(msg, entry, db)
        return
      case 'cms.schedule.cancel':
        await handleScheduleCancel(msg, entry, db)
        return
      case 'cms.media.registerStorageAdapter':
        await handleMediaRegisterStorageAdapter(msg, entry, db)
        return
      case 'cms.media.registerUrlTransformer':
        await handleMediaRegisterUrlTransformer(msg, entry, db)
        return
      case 'cms.media.registerVariantDelegate':
        await handleMediaRegisterVariantDelegate(msg, entry, db)
        return
      case 'crypto.digest':
        await handleCryptoDigest(msg, entry, db)
        return
      case 'crypto.signHmac':
        await handleCryptoSignHmac(msg, entry, db)
        return
      case 'cms.content.tables.list':
        await handleContentTablesList(msg, entry, db)
        return
      case 'cms.content.tables.get':
        await handleContentTablesGet(msg, entry, db)
        return
      case 'cms.content.tables.create':
        await handleContentTablesCreate(msg, entry, db)
        return
      case 'cms.content.entries.list':
        await handleContentEntriesList(msg, entry, db)
        return
      case 'cms.content.entries.get':
        await handleContentEntriesGet(msg, entry, db)
        return
      case 'cms.content.entries.getBySlug':
        await handleContentEntriesGetBySlug(msg, entry, db)
        return
      case 'cms.content.entries.create':
        await handleContentEntriesCreate(msg, entry, db)
        return
      case 'cms.content.entries.update':
        await handleContentEntriesUpdate(msg, entry, db)
        return
      case 'cms.content.entries.delete':
        await handleContentEntriesDelete(msg, entry, db)
        return
      case 'cms.content.entries.publish':
        await handleContentEntriesPublish(msg, entry, db)
        return
      case 'cms.content.entries.moveTable':
        await handleContentEntriesMoveTable(msg, entry, db)
        return
      case 'cms.content.entries.createMany':
        await handleContentEntriesCreateMany(msg, entry, db)
        return
      case 'cms.content.entries.updateMany':
        await handleContentEntriesUpdateMany(msg, entry, db)
        return
      case 'cms.content.entries.deleteMany':
        await handleContentEntriesDeleteMany(msg, entry, db)
        return
      case 'cms.content.tree.read':
        await handleContentTreeRead(msg, entry, db)
        return
      case 'cms.content.tree.mutate':
        await handleContentTreeMutate(msg, entry, db)
        return
      case 'cms.content.tree.replace':
        await handleContentTreeReplace(msg, entry, db)
        return
      case 'cms.content.search':
        await handleContentSearch(msg, entry, db)
        return
      case 'cms.content.snapshot':
        await handleContentSnapshot(msg, entry, db)
        return
      case 'cms.content.republishAll':
        await handleContentRepublishAll(msg, entry, db)
        return
    }
  } catch (err) {
    replyApiError(msg.pluginId, msg.correlationId, err instanceof Error ? err.message : String(err))
  }
}
