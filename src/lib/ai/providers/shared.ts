import { AiError, type AiUsage, type ChatMessage } from '../types'

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  let errorCode = ''
  try {
    const body = (await res.json()) as {
      error?: { message?: string; code?: string; type?: string } | string
    }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
    if (typeof body?.error === 'object') errorCode = `${body.error.code ?? ''} ${body.error.type ?? ''}`
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  // Out of credits is NOT a rate limit: OpenAI sends it as a 429
  // `insufficient_quota`, Anthropic as a 400 "credit balance is too low".
  // Retrying never helps — it needs someone to top up billing (2026-10-07:
  // VSR's OpenAI balance ran out and every guest got "dificultad temporal").
  const code = isQuotaExhausted(`${errorCode} ${detail}`)
    ? 'quota_exhausted'
    : status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'quota_exhausted'
      ? `${provider} account is out of credits`
      : code === 'invalid_key'
        ? `${provider} rejected the API key`
        : code === 'rate_limited'
          ? `${provider} rate limit reached`
          : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/** Provider error text that means the account's billing balance is empty. */
export function isQuotaExhausted(text: string): boolean {
  return /insufficient_quota|no credits remaining|credit balance is too low|exceeded your current quota/i.test(text)
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
      if (m.images?.length) {
        last.images = [...(last.images ?? []), ...m.images]
      }
    } else {
      out.push({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })
    }
  }
  return out
}
