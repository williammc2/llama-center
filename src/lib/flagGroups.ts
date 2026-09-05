/** Structured representation of llama-server "extra flags".
 *
 * The backend still receives a flat `extra_flags` string; this module
 * parses it into typed groups for the UI and serializes back on save.
 * Unknown flags are preserved in `custom` verbatim.
 */

export interface SamplingFlags {
  temp?: number
  topP?: number
  topK?: number
  minP?: number
}

export interface SpecDecodingFlags {
  type?: string
  nMax?: number
}

export interface FlashAttentionFlags {
  enabled?: boolean
}

export interface KvCacheFlags {
  typeK?: string
  typeV?: string
}

export interface BatchingFlags {
  parallel?: number
  threadsBatch?: number
}

export interface ReasoningFlags {
  preserve?: boolean
  effort?: string
  jinja?: boolean
}

export interface ImageFlags {
  minTokens?: number
}

export interface FlagGroups {
  sampling: SamplingFlags
  specDecoding: SpecDecodingFlags
  flashAttention: FlashAttentionFlags
  kvCache: KvCacheFlags
  batching: BatchingFlags
  reasoning: ReasoningFlags
  image: ImageFlags
  custom: string
}

export function emptyFlagGroups(): FlagGroups {
  return {
    sampling: {},
    specDecoding: {},
    flashAttention: {},
    kvCache: {},
    batching: {},
    reasoning: {},
    image: {},
    custom: '',
  }
}

/** Map of known flag names → which group + field they belong to. */
const FLAG_MAP: Record<string, { group: keyof FlagGroups; field: string; type: 'number' | 'string' | 'bool' }> = {
  '--temp': { group: 'sampling', field: 'temp', type: 'number' },
  '--top_p': { group: 'sampling', field: 'topP', type: 'number' },
  '--top_k': { group: 'sampling', field: 'topK', type: 'number' },
  '--min_p': { group: 'sampling', field: 'minP', type: 'number' },

  '--spec-type': { group: 'specDecoding', field: 'type', type: 'string' },
  '--spec-draft-n-max': { group: 'specDecoding', field: 'nMax', type: 'number' },

  '--flash-attn': { group: 'flashAttention', field: 'enabled', type: 'bool' },

  '--cache-type-k': { group: 'kvCache', field: 'typeK', type: 'string' },
  '--cache-type-v': { group: 'kvCache', field: 'typeV', type: 'string' },

  '--parallel': { group: 'batching', field: 'parallel', type: 'number' },
  '--threads-batch': { group: 'batching', field: 'threadsBatch', type: 'number' },

  '--reasoning-preserve': { group: 'reasoning', field: 'preserve', type: 'bool' },
  '--reasoning_effort': { group: 'reasoning', field: 'effort', type: 'string' },
  '--jinja': { group: 'reasoning', field: 'jinja', type: 'bool' },

  '--image-min-tokens': { group: 'image', field: 'minTokens', type: 'number' },
}

/** Parse a raw extra_flags string into structured groups. */
export function parseFlagGroups(raw: string): FlagGroups {
  const g = emptyFlagGroups()
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const custom: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok.startsWith('--')) {
      custom.push(tok)
      continue
    }
    const mapping = FLAG_MAP[tok]
    if (!mapping) {
      // Unknown flag: keep it (and its value if any) in custom
      custom.push(tok)
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        custom.push(tokens[++i])
      }
      continue
    }
    const target = g[mapping.group] as Record<string, unknown>
    if (mapping.type === 'bool') {
      // --flag on / --flag off / --flag (bare = on)
      if (i + 1 < tokens.length && (tokens[i + 1] === 'on' || tokens[i + 1] === 'off')) {
        target[mapping.field] = tokens[++i] === 'on'
      } else {
        target[mapping.field] = true
      }
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
      const val = tokens[++i]
      target[mapping.field] = mapping.type === 'number' ? Number(val) : val
    }
  }

  g.custom = custom.join(' ')
  return g
}

/** Serialize structured groups back to a raw extra_flags string. */
export function serializeFlagGroups(g: FlagGroups): string {
  const parts: string[] = []

  const s = g.sampling
  if (s.temp != null) parts.push(`--temp ${s.temp}`)
  if (s.topP != null) parts.push(`--top_p ${s.topP}`)
  if (s.topK != null) parts.push(`--top_k ${s.topK}`)
  if (s.minP != null) parts.push(`--min_p ${s.minP}`)

  const sd = g.specDecoding
  if (sd.type) parts.push(`--spec-type ${sd.type}`)
  if (sd.nMax != null) parts.push(`--spec-draft-n-max ${sd.nMax}`)

  if (g.flashAttention.enabled != null)
    parts.push(`--flash-attn ${g.flashAttention.enabled ? 'on' : 'off'}`)

  const kv = g.kvCache
  if (kv.typeK) parts.push(`--cache-type-k ${kv.typeK}`)
  if (kv.typeV) parts.push(`--cache-type-v ${kv.typeV}`)

  const b = g.batching
  if (b.parallel != null) parts.push(`--parallel ${b.parallel}`)
  if (b.threadsBatch != null) parts.push(`--threads-batch ${b.threadsBatch}`)

  const r = g.reasoning
  if (r.preserve) parts.push('--reasoning-preserve')
  if (r.effort) parts.push(`--reasoning_effort ${r.effort}`)
  if (r.jinja) parts.push('--jinja')

  if (g.image.minTokens != null) parts.push(`--image-min-tokens ${g.image.minTokens}`)

  if (g.custom.trim()) parts.push(g.custom.trim())

  return parts.join(' ')
}

/** Returns true when the group has at least one value set. */
export function groupHasValues(g: FlagGroups): Record<keyof FlagGroups, boolean> {
  return {
    sampling: Object.values(g.sampling).some((v) => v != null),
    specDecoding: Object.values(g.specDecoding).some((v) => v != null),
    flashAttention: g.flashAttention.enabled != null,
    kvCache: Object.values(g.kvCache).some((v) => v != null),
    batching: Object.values(g.batching).some((v) => v != null),
    reasoning: Object.values(g.reasoning).some((v) => v != null),
    image: g.image.minTokens != null,
    custom: g.custom.trim().length > 0,
  }
}
