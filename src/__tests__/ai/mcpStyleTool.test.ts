import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { styleMcpTools } from '../../../server/ai/mcp/tools/styleTools'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import type { ToolContext } from '../../../server/ai/runtime/types'

async function seedClass(harness: CapabilityTestHarness): Promise<void> {
  const site = await getDraftSite(harness.db)
  if (!site) throw new Error('no default site')
  const now = Date.now()
  site.styleRules['r_testcard'] = {
    id: 'r_testcard',
    name: 'test-card',
    kind: 'class',
    selector: '.test-card',
    order: 0,
    styles: { color: 'red', padding: '10px' },
    contextStyles: {},
    createdAt: now,
    updatedAt: now,
  }
  await saveDraftSite(harness.db, site)
}

function ctxFor(harness: CapabilityTestHarness): ToolContext {
  return {
    db: harness.db,
    userId: 'u1',
    capabilities: ['site.read'],
    scope: 'site',
    conversationId: 'test',
    snapshot: null, // headless — no browser snapshot, unlike the old list_tokens
    signal: new AbortController().signal,
  }
}

const readStyles = styleMcpTools.find((t) => t.name === 'read_styles')!

describe('read_styles (headless design-system read)', () => {
  let harness: CapabilityTestHarness
  let originalError: typeof console.error

  beforeEach(async () => {
    originalError = console.error
    console.error = () => {}
    harness = await createCapabilityTestHarness()
    await harness.setupOwner() // creates the default site shell
  })
  afterEach(() => { console.error = originalError })

  it('returns a seeded class as CSS without needing a snapshot', async () => {
    await seedClass(harness)
    const out = (await readStyles.handler!({}, ctxFor(harness))) as { css: string; classCount: number }
    expect(typeof out.css).toBe('string')
    expect(out.classCount).toBe(1)
    expect(out.css).toContain('.test-card')
    expect(out.css).toContain('color: red')
  })

  it('can scope output to a single class by name', async () => {
    await seedClass(harness)
    const out = (await readStyles.handler!({ className: 'test-card' }, ctxFor(harness))) as { css: string }
    expect(out.css).toContain('.test-card')
  })

  it('errors clearly for an unknown class name', async () => {
    const out = (await readStyles.handler!({ className: 'no-such-class' }, ctxFor(harness))) as {
      ok?: boolean
      error?: string
    }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('no-such-class')
  })

  it('is gated on a site read capability', () => {
    expect(readStyles.requiredCapabilities).toContain('site.read')
    expect(readStyles.execution).toBe('server')
    expect(readStyles.mutates).toBeFalsy()
  })
})
