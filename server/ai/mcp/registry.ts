/**
 * MCP tool registry — the full set of tools an external MCP client may use,
 * filtered to the connector's granted capabilities.
 *
 * Two execution classes are exposed:
 *   - server-resolved tools (content reads, `read_page_tree`, `mutate_page_tree`)
 *     run in-process and work with NO editor open;
 *   - browser tools (HTML/CSS authoring, design tokens, page lifecycle, content
 *     CRUD, code assets, live-DOM reads) are relayed to the connector owner's
 *     open editor via the live editor bridge (`./editorBridge`). If no editor is
 *     connected, the call returns a clear error telling the agent to open it.
 *
 * Capability filtering reuses the SAME gate the built-in agent uses
 * (`toolAllowedForCapabilities`): a connector without `ai.tools.write` never
 * sees a mutating tool, and a tool's `requiredCapabilities` (ANY-OF) must be
 * held. An MCP caller can never invoke a tool the granting capabilities
 * couldn't authorize over HTTP.
 */
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../runtime/types'
import { toolAllowedForCapabilities } from '../tools/capabilityGate'
import { contentTools } from '../tools/content'
import { siteTools } from '../tools/site'
import { pageTreeMcpTools } from './tools/pageTreeTools'
import { styleMcpTools } from './tools/styleTools'

// Server-resolved site read tools whose handlers read the browser-posted
// `ctx.snapshot`, which is null over MCP — they'd silently return nothing.
// `read_styles` (headless, reads the DB) replaces what `list_tokens` offered;
// breakpoints surface in the media queries `read_styles` emits.
const MCP_EXCLUDED_TOOLS = new Set<string>(['list_tokens', 'list_breakpoints'])

function allMcpTools(): AiTool[] {
  // De-dup by tool name. Order matters: the headless page-tree, style, and
  // content tools win over the site toolset for any shared name (e.g.
  // `list_documents`), so the version that works without an open editor is the
  // one exposed.
  const ordered = [...pageTreeMcpTools, ...styleMcpTools, ...contentTools, ...siteTools]
  const byName = new Map<string, AiTool>()
  for (const tool of ordered) {
    if (MCP_EXCLUDED_TOOLS.has(tool.name)) continue
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  return [...byName.values()]
}

export function mcpToolsForCapabilities(capabilities: readonly CoreCapability[]): AiTool[] {
  return allMcpTools().filter((t) => toolAllowedForCapabilities(t, capabilities))
}
