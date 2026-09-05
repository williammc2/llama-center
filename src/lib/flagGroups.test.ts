import { describe, it, expect } from 'vitest'
import { parseFlagGroups, serializeFlagGroups, emptyFlagGroups, groupHasValues } from './flagGroups'

describe('parseFlagGroups', () => {
  it('empty string → empty groups', () => {
    const g = parseFlagGroups('')
    expect(g).toEqual(emptyFlagGroups())
  })

  it('parses sampling flags', () => {
    const g = parseFlagGroups('--temp 0.7 --top_p 0.95 --top_k 20 --min_p 0.0')
    expect(g.sampling).toEqual({ temp: 0.7, topP: 0.95, topK: 20, minP: 0 })
  })

  it('parses flash-attn on', () => {
    const g = parseFlagGroups('--flash-attn on')
    expect(g.flashAttention).toEqual({ enabled: true })
  })

  it('parses flash-attn off', () => {
    const g = parseFlagGroups('--flash-attn off')
    expect(g.flashAttention).toEqual({ enabled: false })
  })

  it('parses spec decoding', () => {
    const g = parseFlagGroups('--spec-type draft-mtp --spec-draft-n-max 4')
    expect(g.specDecoding).toEqual({ type: 'draft-mtp', nMax: 4 })
  })

  it('parses kv cache types', () => {
    const g = parseFlagGroups('--cache-type-k q4_0 --cache-type-v q4_0')
    expect(g.kvCache).toEqual({ typeK: 'q4_0', typeV: 'q4_0' })
  })

  it('parses batching', () => {
    const g = parseFlagGroups('--parallel 1 --threads-batch 16')
    expect(g.batching).toEqual({ parallel: 1, threadsBatch: 16 })
  })

  it('parses reasoning flags', () => {
    const g = parseFlagGroups('--reasoning-preserve --jinja --reasoning_effort medium')
    expect(g.reasoning).toEqual({ preserve: true, effort: 'medium', jinja: true })
  })

  it('parses image flags', () => {
    const g = parseFlagGroups('--image-min-tokens 1024')
    expect(g.image).toEqual({ minTokens: 1024 })
  })

  it('unknown flags go to custom', () => {
    const g = parseFlagGroups('--temp 0.7 --some-new-flag 42 --another-flag')
    expect(g.sampling).toEqual({ temp: 0.7 })
    expect(g.custom).toBe('--some-new-flag 42 --another-flag')
  })

  it('full real-world config round-trips', () => {
    const raw =
      '--parallel 1 --image-min-tokens 1024 --threads-batch 16 --flash-attn on ' +
      '--cache-type-k q4_0 --cache-type-v q4_0 --reasoning-preserve --jinja ' +
      '--spec-type draft-mtp --reasoning_effort medium --spec-draft-n-max 4 ' +
      '--spec-draft-type-k q8_0 --spec-draft-type-v q8_0 ' +
      '--temp 0.7 --top_p 0.95 --top_k 20 --min_p 0.0'
    const g = parseFlagGroups(raw)
    expect(g.sampling).toEqual({ temp: 0.7, topP: 0.95, topK: 20, minP: 0 })
    expect(g.batching).toEqual({ parallel: 1, threadsBatch: 16 })
    expect(g.flashAttention).toEqual({ enabled: true })
    expect(g.kvCache).toEqual({ typeK: 'q4_0', typeV: 'q4_0' })
    expect(g.reasoning).toEqual({ preserve: true, effort: 'medium', jinja: true })
    expect(g.specDecoding).toEqual({ type: 'draft-mtp', nMax: 4 })
    expect(g.image).toEqual({ minTokens: 1024 })
    // Unknown spec-draft-type-k/v go to custom
    expect(g.custom).toContain('--spec-draft-type-k q8_0')
    expect(g.custom).toContain('--spec-draft-type-v q8_0')
  })

  it('handles extra whitespace', () => {
    const g = parseFlagGroups('  --temp   0.7   --top_p  0.95  ')
    expect(g.sampling).toEqual({ temp: 0.7, topP: 0.95 })
  })
})

describe('serializeFlagGroups', () => {
  it('empty groups → empty string', () => {
    expect(serializeFlagGroups(emptyFlagGroups())).toBe('')
  })

  it('serializes sampling', () => {
    const g = emptyFlagGroups()
    g.sampling = { temp: 0.7, topP: 0.95, topK: 20, minP: 0 }
    const out = serializeFlagGroups(g)
    expect(out).toContain('--temp 0.7')
    expect(out).toContain('--top_p 0.95')
    expect(out).toContain('--top_k 20')
    expect(out).toContain('--min_p 0')
  })

  it('serializes flash-attn on/off', () => {
    const g = emptyFlagGroups()
    g.flashAttention = { enabled: true }
    expect(serializeFlagGroups(g)).toBe('--flash-attn on')
    g.flashAttention = { enabled: false }
    expect(serializeFlagGroups(g)).toBe('--flash-attn off')
  })

  it('appends custom flags at the end', () => {
    const g = emptyFlagGroups()
    g.sampling = { temp: 0.7 }
    g.custom = '--my-custom-flag 1'
    const out = serializeFlagGroups(g)
    expect(out).toBe('--temp 0.7 --my-custom-flag 1')
  })

  it('round-trip: parse → serialize → parse produces same groups', () => {
    const raw = '--temp 0.7 --flash-attn on --cache-type-k q8_0 --parallel 2'
    const g1 = parseFlagGroups(raw)
    const serialized = serializeFlagGroups(g1)
    const g2 = parseFlagGroups(serialized)
    expect(g2.sampling).toEqual(g1.sampling)
    expect(g2.flashAttention).toEqual(g1.flashAttention)
    expect(g2.kvCache).toEqual(g1.kvCache)
    expect(g2.batching).toEqual(g1.batching)
  })
})

describe('groupHasValues', () => {
  it('all empty → all false', () => {
    expect(groupHasValues(emptyFlagGroups())).toEqual({
      sampling: false,
      specDecoding: false,
      flashAttention: false,
      kvCache: false,
      batching: false,
      reasoning: false,
      image: false,
      custom: false,
    })
  })

  it('detects populated groups', () => {
    const g = parseFlagGroups('--temp 0.7 --flash-attn on')
    const has = groupHasValues(g)
    expect(has.sampling).toBe(true)
    expect(has.flashAttention).toBe(true)
    expect(has.kvCache).toBe(false)
  })
})
