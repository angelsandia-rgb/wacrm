import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  executeReadTool: vi.fn(),
}))

vi.mock('./tools', () => ({
  ASSISTANT_TOOLS: [
    { name: 'get_business_metrics', description: 'x', input_schema: { type: 'object', properties: {} } },
    { name: 'move_deal', description: 'x', input_schema: { type: 'object', properties: {} } },
  ],
  executeReadTool: h.executeReadTool,
  isWriteTool: (name: string) => name === 'move_deal',
}))

import { runAssistantTurnOpenAi } from './openai-tools'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}
function toolCall(id: string, name: string, args: unknown) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

const db = {} as SupabaseClient
const baseArgs = {
  db,
  accountId: 'acct-1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  systemPrompt: 'be helpful',
  timeoutMs: 5000,
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  h.executeReadTool.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('runAssistantTurnOpenAi', () => {
  it('sends a system message + the tool catalog and returns plain text', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({
        choices: [{ message: { role: 'assistant', content: 'You won 3 deals this month.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    )

    const result = await runAssistantTurnOpenAi({
      ...baseArgs,
      messages: [{ role: 'user', content: 'how many deals did we win?' }],
    })

    expect(result.reply).toBe('You won 3 deals this month.')
    expect(result.pendingAction).toBeNull()
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 })

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'get_business_metrics' } })
  })

  it('stops the loop and proposes a write action without executing it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Moving it now.',
              tool_calls: [toolCall('call_1', 'move_deal', { targetId: 'deal-1', stageId: 'stage-2' })],
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
    )

    const result = await runAssistantTurnOpenAi({
      ...baseArgs,
      messages: [{ role: 'user', content: "move Juan's deal to Won" }],
    })

    expect(result.pendingAction).toEqual({
      action: 'move_deal',
      input: { targetId: 'deal-1', stageId: 'stage-2' },
    })
    expect(h.executeReadTool).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('executes read tools and feeds a `tool` message back before answering', async () => {
    h.executeReadTool.mockResolvedValueOnce({ deals: { won: 3, lost: 1 } })
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        okResponse({
          choices: [
            { message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'get_business_metrics', {})] } },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 5 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ message: { role: 'assistant', content: 'You won 3 and lost 1.' } }],
          usage: { prompt_tokens: 40, completion_tokens: 8 },
        }),
      )

    const result = await runAssistantTurnOpenAi({
      ...baseArgs,
      messages: [{ role: 'user', content: 'summarize my sales' }],
    })

    expect(h.executeReadTool).toHaveBeenCalledWith(db, 'acct-1', 'get_business_metrics', {})
    expect(result.reply).toBe('You won 3 and lost 1.')
    expect(result.usage).toEqual({ promptTokens: 70, completionTokens: 13, totalTokens: 83 })
    expect(fetch).toHaveBeenCalledTimes(2)

    const secondBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string)
    const msgs = secondBody.messages
    expect(msgs[msgs.length - 2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] })
    expect(msgs[msgs.length - 1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: JSON.stringify({ deals: { won: 3, lost: 1 } }),
    })
  })

  it('surfaces a failed read tool as an ERROR tool message instead of throwing', async () => {
    h.executeReadTool.mockRejectedValueOnce(new Error('boom'))
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        okResponse({
          choices: [
            { message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'get_business_metrics', {})] } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ message: { role: 'assistant', content: 'Something went wrong looking that up.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )

    const result = await runAssistantTurnOpenAi({
      ...baseArgs,
      messages: [{ role: 'user', content: 'summarize my sales' }],
    })

    expect(result.reply).toBe('Something went wrong looking that up.')
    const secondBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string)
    const last = secondBody.messages[secondBody.messages.length - 1]
    expect(last).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'ERROR: boom' })
  })

  it('bails out with a fallback reply after MAX_TOOL_ROUNDS of read-tool calls', async () => {
    h.executeReadTool.mockResolvedValue({})
    vi.mocked(fetch).mockResolvedValue(
      okResponse({
        choices: [
          { message: { role: 'assistant', content: null, tool_calls: [toolCall('call_x', 'get_business_metrics', {})] } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    )

    const result = await runAssistantTurnOpenAi({
      ...baseArgs,
      messages: [{ role: 'user', content: 'keep digging forever' }],
    })

    expect(result.pendingAction).toBeNull()
    expect(result.reply).toMatch(/narrow it down/i)
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('treats unparseable write-tool arguments as an empty proposal, not a crash', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'move_deal', arguments: '{bad json' } }],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    )

    const result = await runAssistantTurnOpenAi({
      ...baseArgs,
      messages: [{ role: 'user', content: 'move it' }],
    })

    expect(result.pendingAction).toEqual({ action: 'move_deal', input: {} })
  })
})
