/** Structured representation of llama-server "extra flags".
 *
 * The backend still receives a flat `extra_flags` string; this module
 * parses it into typed groups for the UI and serializes back on save.
 * Unknown flags are preserved in `custom` verbatim.
 *
 * One map (`FLAG_MAP`) drives BOTH directions, so a flag can't be parseable
 * but unserializable. Insertion order of the map IS the serialization order.
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

type FlagType = 'number' | 'string' | 'bool'
/** How a bool flag serializes:
 *   - `onoff`: always emit `flag on|off` when set (flash-attn — off is meaningful);
 *   - `bare`:  emit the bare flag only when true (reasoning-preserve, jinja —
 *              absence of the flag means "off", so a `false` writes nothing). */
type BoolMode = 'onoff' | 'bare'

interface FlagSpec {
  group: keyof FlagGroups
  field: string
  type: FlagType
  boolMode?: BoolMode
}

/** Map of known flag names → which group + field they belong to, their value
 *  type, and (for bools) how they serialize. */
const FLAG_MAP: Record<string, FlagSpec> = {
  '--temp': { group: 'sampling', field: 'temp', type: 'number' },
  '--top_p': { group: 'sampling', field: 'topP', type: 'number' },
  '--top_k': { group: 'sampling', field: 'topK', type: 'number' },
  '--min_p': { group: 'sampling', field: 'minP', type: 'number' },

  '--spec-type': { group: 'specDecoding', field: 'type', type: 'string' },
  '--spec-draft-n-max': { group: 'specDecoding', field: 'nMax', type: 'number' },

  '--flash-attn': { group: 'flashAttention', field: 'enabled', type: 'bool', boolMode: 'onoff' },

  '--cache-type-k': { group: 'kvCache', field: 'typeK', type: 'string' },
  '--cache-type-v': { group: 'kvCache', field: 'typeV', type: 'string' },

  '--parallel': { group: 'batching', field: 'parallel', type: 'number' },
  '--threads-batch': { group: 'batching', field: 'threadsBatch', type: 'number' },

  '--reasoning-preserve': { group: 'reasoning', field: 'preserve', type: 'bool', boolMode: 'bare' },
  '--reasoning_effort': { group: 'reasoning', field: 'effort', type: 'string' },
  '--jinja': { group: 'reasoning', field: 'jinja', type: 'bool', boolMode: 'bare' },

  '--image-min-tokens': { group: 'image', field: 'minTokens', type: 'number' },
}

/** Parse a raw extra_flags string into structured groups. */
export function parseFlagGroups(raw: string): FlagGroups {
  const g = emptyFlagGroups()
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const custom: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (!tok.startsWith('--')) {
      custom.push(tok)
      continue
    }
    const mapping = FLAG_MAP[tok]
    if (!mapping) {
      // Unknown flag: keep it (and its value if any) in custom
      custom.push(tok)
      if (i + 1 < tokens.length && !tokens[i + 1]!.startsWith('--')) {
        custom.push(tokens[++i]!)
      }
      continue
    }
    const target = g[mapping.group] as Record<string, unknown>
    if (mapping.type === 'bool') {
      // --flag on / --flag off / --flag (bare = on)
      if (i + 1 < tokens.length && (tokens[i + 1] === 'on' || tokens[i + 1] === 'off')) {
        target[mapping.field] = tokens[++i]! === 'on'
      } else {
        target[mapping.field] = true
      }
    } else if (i + 1 < tokens.length && !tokens[i + 1]!.startsWith('--')) {
      const val = tokens[++i]!
      target[mapping.field] = mapping.type === 'number' ? Number(val) : val
    }
  }

  g.custom = custom.join(' ')
  return g
}

/** Serialize one flag's value into its tokens (empty when unset). */
function flagTokens(flag: string, spec: FlagSpec, value: unknown): string[] {
  if (value == null) return []
  switch (spec.type) {
    case 'number':
      return [`${flag} ${value}`]
    case 'string':
      return value ? [`${flag} ${value}`] : []
    case 'bool':
      if (spec.boolMode === 'onoff') return [`${flag} ${value ? 'on' : 'off'}`]
      return value ? [flag] : []
  }
}

/** Serialize structured groups back to a raw extra_flags string. */
export function serializeFlagGroups(g: FlagGroups): string {
  const parts: string[] = []
  for (const [flag, spec] of Object.entries(FLAG_MAP)) {
    const value = (g[spec.group] as Record<string, unknown>)[spec.field]
    parts.push(...flagTokens(flag, spec, value))
  }
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
