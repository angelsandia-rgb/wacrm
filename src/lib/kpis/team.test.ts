import { describe, expect, it } from 'vitest'
import { agentResponseMinutes, median, pipelineFunnels } from './team'

describe('pipelineFunnels', () => {
  const stages = [
    { id: 's2', pipeline_id: 'p', name: 'Cotizado', position: 2, color: null },
    { id: 's1', pipeline_id: 'p', name: 'Nuevo', position: 1, color: null },
    { id: 's3', pipeline_id: 'p', name: 'Cerrado', position: 3, color: null },
  ]

  it('counts deals that reached each stage, won deals reach all', () => {
    const [f] = pipelineFunnels([{ id: 'p', name: 'Ventas' }], stages, [
      { id: 'a', pipeline_id: 'p', stage_id: 's1', status: 'open' },
      { id: 'b', pipeline_id: 'p', stage_id: 's2', status: 'lost' },
      { id: 'c', pipeline_id: 'p', stage_id: 's1', status: 'won' },
    ])
    expect(f.stages.map((s) => [s.name, s.reached])).toEqual([
      ['Nuevo', 3],
      ['Cotizado', 2],
      ['Cerrado', 1],
    ])
    expect([f.total, f.won, f.lost]).toEqual([3, 1, 1])
  })

  it('counts the furthest stage in the history, not just the current one', () => {
    const [f] = pipelineFunnels(
      [{ id: 'p', name: 'Ventas' }],
      stages,
      [{ id: 'a', pipeline_id: 'p', stage_id: 's1', status: 'open' }],
      [
        { deal_id: 'a', to_stage_id: 's1' },
        { deal_id: 'a', to_stage_id: 's2' },
        { deal_id: 'a', to_stage_id: 's1' },
      ],
    )
    expect(f.stages.map((s) => s.reached)).toEqual([1, 1, 0])
  })

  it('drops pipelines with no deals in the window', () => {
    expect(pipelineFunnels([{ id: 'p', name: 'Ventas' }], stages, [])).toEqual([])
  })
})

describe('agentResponseMinutes', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 10, min)).toISOString()

  it('credits the teammate from the first waiting customer message', () => {
    const r = agentResponseMinutes([
      { conversation_id: 'c', sender_type: 'customer', sender_id: null, created_at: at(0) },
      { conversation_id: 'c', sender_type: 'customer', sender_id: null, created_at: at(3) },
      { conversation_id: 'c', sender_type: 'agent', sender_id: 'u1', created_at: at(10) },
      { conversation_id: 'c', sender_type: 'agent', sender_id: 'u1', created_at: at(11) },
    ])
    expect(r.get('u1')).toEqual([10])
  })

  it('a bot or automated reply clears the wait without crediting anyone', () => {
    const r = agentResponseMinutes([
      { conversation_id: 'c', sender_type: 'customer', sender_id: null, created_at: at(0) },
      { conversation_id: 'c', sender_type: 'bot', sender_id: null, created_at: at(1) },
      { conversation_id: 'c', sender_type: 'agent', sender_id: 'u1', created_at: at(5) },
    ])
    expect(r.size).toBe(0)
  })
})

describe('median', () => {
  it('handles empty, odd and even sets', () => {
    expect(median([])).toBeNull()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})
