import { describe, expect, it } from 'bun:test'
import {
  createAnthropicStreamState,
  toAiStreamEvents,
} from '../../../server/ai/drivers/anthropicStream'

describe('agent handler SDK streaming', () => {
  it('forwards SDK session IDs so the browser can resume follow-up turns', () => {
    const state = createAnthropicStreamState()

    const events = toAiStreamEvents({
      type: 'system',
      subtype: 'init',
      session_id: '00000000-0000-4000-8000-000000000001',
    }, state)

    expect(events).toEqual([
      {
        type: 'session',
        sessionId: '00000000-0000-4000-8000-000000000001',
      },
    ])
  })

  it('forwards complete assistant messages immediately instead of waiting for result', () => {
    const state = createAnthropicStreamState()

    const events = toAiStreamEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will update the heading.' },
        ],
      },
    }, state)

    expect(events).toEqual([
      { type: 'text', text: 'I will update the heading.' },
    ])
  })

  it('turns partial SDK text and tool events into browser stream events', () => {
    const state = createAnthropicStreamState()

    expect(toAiStreamEvents({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Checking the page...' },
      },
    }, state)).toEqual([
      { type: 'text', text: 'Checking the page...' },
    ])

    expect(toAiStreamEvents({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'mcp__page_builder__inspect_page',
          input: {},
        },
      },
    }, state)).toEqual([
      {
        type: 'toolCall',
        toolCallId: 'toolu_1',
        toolName: 'mcp__page_builder__inspect_page',
        status: 'pending',
        input: {},
      },
    ])

    expect(toAiStreamEvents({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
        ],
      },
    }, state)).toEqual([
      {
        type: 'toolResult',
        toolCallId: 'toolu_1',
        toolName: 'mcp__page_builder__inspect_page',
        ok: true,
      },
    ])
  })
})
