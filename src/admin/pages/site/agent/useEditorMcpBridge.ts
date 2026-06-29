/**
 * useEditorMcpBridge — holds the MCP "live editor bridge" open while the site
 * editor is mounted.
 *
 * External MCP clients (Claude Code, Codex, remote agents) can use the editor's
 * browser-execution tools (insert HTML, apply CSS, set tokens, manage pages,
 * content CRUD, …) only when an editor is open to run them. This hook opens the
 * long-lived NDJSON stream at `/admin/api/ai/editor-bridge`; when the server
 * relays a `toolRequest`, it runs the SAME `executeAgentTool` the agent panel
 * uses against the live store and POSTs the result back through the existing
 * tool-result endpoint (`postToolResult`).
 *
 * The stream reconnects with a fixed backoff while mounted so a transient drop
 * doesn't silently disable MCP editing.
 */
import { useEffect } from 'react'
import { Type } from '@core/utils/typeboxHelpers'
import { isAbortError } from '@core/http'
import type { AiToolOutput } from '@core/ai'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { readNdjsonStream } from './ndjsonStream'
import { executeAgentTool } from './executor'
import { postToolResult } from './agentApi'
import { flushEditorSave } from '../hooks/editorSaveRef'

const EDITOR_BRIDGE_PATH = '/admin/api/ai/editor-bridge'
const RECONNECT_DELAY_MS = 3000

const BridgeEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('bridgeReady'), bridgeId: Type.String() }),
  Type.Object({
    type: Type.Literal('toolRequest'),
    requestId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
  }),
])

export function useEditorMcpBridge(): void {
  useEffect(() => {
    const controller = new AbortController()
    let stopped = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    async function connectOnce(): Promise<void> {
      let bridgeId = ''
      const res = await fetch(EDITOR_BRIDGE_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/x-ndjson' },
        signal: controller.signal,
      })
      // 401/403 (not signed in / lacks site.read) — don't spin reconnecting.
      if (res.status === 401 || res.status === 403) {
        stopped = true
        return
      }
      if (!res.ok || !res.body) return

      for await (const event of readNdjsonStream(res.body.getReader(), BridgeEventSchema)) {
        if (stopped) break
        if (event.type === 'bridgeReady') {
          bridgeId = event.bridgeId
          continue
        }
        // toolRequest: run against the live editor store, then post the result.
        let result: AiToolOutput
        try {
          result = await executeAgentTool(event.toolName, event.input)
          // If the tool mutated the store, flush the draft to the DB so a
          // follow-up headless MCP read (read_styles / content reads) sees the
          // change instead of stale state.
          if (result.ok && useEditorStore.getState().hasUnsavedChanges) {
            try {
              await flushEditorSave()
            } catch (err) {
              console.error('[editor-mcp-bridge] flush save failed:', err)
            }
          }
        } catch (err) {
          result = { ok: false, error: getErrorMessage(err, 'Tool failed.') }
        }
        await postToolResult(bridgeId, event.requestId, result, controller.signal).catch(() => {})
      }
    }

    async function loop(): Promise<void> {
      while (!stopped) {
        try {
          await connectOnce()
        } catch (err) {
          if (isAbortError(err) || stopped) break
          console.error('[editor-mcp-bridge] stream error:', err)
        }
        if (stopped) break
        await new Promise<void>((resolve) => {
          reconnectTimer = setTimeout(resolve, RECONNECT_DELAY_MS)
        })
      }
    }

    void loop()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      controller.abort()
    }
  }, [])
}
