import { describe, expect, it } from 'bun:test'
import { mcpToolsForCapabilities } from './registry'

const FULL: Parameters<typeof mcpToolsForCapabilities>[0] = [
  'ai.chat',
  'ai.tools.write',
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'content.manage',
  'content.create',
  'content.edit.any',
  'data.custom.tables.read',
  'data.system.tables.read',
  'media.read',
  'media.write',
]

describe('mcp registry', () => {
  it('exposes the full catalog: headless server tools + browser tools', () => {
    const tools = mcpToolsForCapabilities(FULL)
    const names = tools.map((t) => t.name)
    // headless (server-resolved)
    expect(names).toContain('read_page_tree')
    expect(names).toContain('mutate_page_tree')
    expect(names).toContain('read_styles') // headless design-system read
    expect(names).toContain('list_collections')
    // browser-execution (relayed via the editor bridge)
    expect(names).toContain('insertHtml')
    expect(names).toContain('applyCss')
    expect(names).toContain('set_color_tokens')
    expect(tools.some((t) => t.execution === 'browser')).toBe(true)
  })

  it('excludes the snapshot-dependent site read tools that break headless', () => {
    const names = mcpToolsForCapabilities(FULL).map((t) => t.name)
    // list_tokens / list_breakpoints read ctx.snapshot (null over MCP) — excluded.
    expect(names).not.toContain('list_tokens')
    expect(names).not.toContain('list_breakpoints')
  })

  it('de-dupes shared tool names (e.g. list_documents appears once)', () => {
    const names = mcpToolsForCapabilities(FULL).map((t) => t.name)
    expect(names.filter((n) => n === 'list_documents')).toHaveLength(1)
  })

  it('filters out mutating tools when ai.tools.write is absent', () => {
    const readOnly = FULL.filter((c) => c !== 'ai.tools.write')
    const tools = mcpToolsForCapabilities(readOnly)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some((t) => t.mutates)).toBe(false)
    expect(tools.some((t) => t.name === 'mutate_page_tree')).toBe(false)
    expect(tools.some((t) => t.name === 'insertHtml')).toBe(false)
  })
})
