/**
 * Model-backed title generation for `/rename`.
 *
 * The generator reads the current session log (direct user messages plus
 * assembled assistant replies), trims that transcript into the configured
 * byte budget, and issues one auxiliary `session-title` model call. It never
 * writes session events itself: the command layer commits the returned text
 * through `ctx.sessionTitle.rename`, which owns the durable `session/title`
 * event.
 * @module dsh-rename/title
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-rename': {
      kind: 'dsh-rename'
    }
  }
}

/** One bounded conversation entry framed for the title model. */
export interface TranscriptEntry {
  /** Speaker role, restricted to the two entries collected from the log. */
  readonly role: 'user' | 'assistant'
  /** Exact visible text from the source message, possibly truncated. */
  readonly text: string
}

/**
 * Join the visible text blocks of one message content list.
 * Reasoning blocks are excluded on purpose: they are auxiliary work, and a
 * session title should name visible conversation state. Unknown future block
 * types fall through without throwing because `ContentBlock` is
 * merge-extensible.
 * @param content - frozen message content blocks.
 * @returns one trimmed line-separated text, or an empty string.
 */
export function textOfContent(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      default:
        break
    }
  }
  return parts.join('\n').trim()
}

/**
 * Collect the human-visible conversation from the session log in log order.
 * Only direct human prompts (`source.kind === 'user'`) and assistant replies
 * are collected; synthetic context messages and raw chunks stay out.
 * @param session - exact live session being named.
 * @returns non-empty text-bearing entries, oldest first.
 */
export function collectTranscriptEntries(session: Session): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const event of session.snapshotEvents()) {
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user') break
        const text = textOfContent(event.data.content)
        if (text.length > 0) entries.push({ role: 'user', text })
        break
      }
      case 'assistant/message': {
        const text = textOfContent(event.data.message.content)
        if (text.length > 0) entries.push({ role: 'assistant', text })
        break
      }
      default:
        break
    }
  }
  return entries
}

/** Exact UTF-8 byte size of the framed transcript. */
function framedBytes(entries: readonly TranscriptEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries), 'utf8')
}

/**
 * Fit collected entries into the framing byte budget.
 * Whole oldest entries are dropped first so the model keeps the latest work;
 * when one oversized entry remains, its text is truncated on code-point
 * boundaries (with an ellipsis) until the framed JSON fits.
 * @param entries - collected transcript, oldest first.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns bounded transcript that fits when JSON-framed.
 */
export function fitTranscript(
  entries: readonly TranscriptEntry[],
  maxBytes: number,
): TranscriptEntry[] {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('dsh-rename: maxInputBytes must be a positive integer')
  }
  const selected = [...entries]
  while (selected.length > 1 && framedBytes(selected) > maxBytes) selected.shift()
  const [only] = selected
  if (only === undefined) return []
  if (framedBytes(selected) <= maxBytes) return selected

  const characters = Array.from(only.text)
  let low = 0
  let high = characters.length
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = { role: only.role, text: characters.slice(0, middle).join('') }
    if (framedBytes([candidate]) <= maxBytes) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best === characters.length) return [only]
  let text = `${characters.slice(0, best).join('')}…`
  while (best > 0 && framedBytes([{ role: only.role, text }]) > maxBytes) {
    best -= 1
    text = `${characters.slice(0, best).join('')}…`
  }
  return [{ role: only.role, text }]
}

/** Stable language-aware instruction for the auxiliary title call. */
function systemPrompt(config: ResolvedConfig): string {
  return [
    'Create a concise, specific title for an AI coding-assistant session from the supplied conversation transcript.',
    "The title must capture the user's goal and the work done so far, not just the first message.",
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, code, or terminal control codes.',
    'Use the language of the conversation.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

/** Frame the bounded transcript so user text cannot break structural delimiters. */
function frameTranscript(entries: readonly TranscriptEntry[]): string {
  return `Rename this session from the conversation transcript below. Transcript entries are JSON objects with role and text fields.\n${JSON.stringify(entries)}`
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'aborted':
    case 'error':
      return new Error(finish.failure.message)
    case 'max-tokens':
      return new Error('dsh-rename: title output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('dsh-rename: title model unexpectedly requested a tool')
    default:
      return new Error(`dsh-rename: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/** Resolve the auxiliary route: explicit config wins, then the session's logged request header. */
function resolveRoute(
  config: ResolvedConfig,
  session: Session,
): { readonly provider: string; readonly model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const header = session.requestHeader()
  if (header === undefined) {
    throw new Error('dsh-rename: no logged model route is available; configure provider and model together')
  }
  return { provider: header.config.provider, model: header.config.model }
}

/**
 * Generate one normalized title from the current session transcript.
 * @param ctx - context exposing the LLM service.
 * @param config - resolved deployment policy.
 * @param session - exact live session being named.
 * @param signal - caller cancellation (typically the slash-command UI request).
 * @returns non-empty normalized title text.
 */
export async function generateSessionTitle(
  ctx: Context,
  config: ResolvedConfig,
  session: Session,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  const entries = fitTranscript(collectTranscriptEntries(session), config.maxInputBytes)
  if (entries.length === 0) {
    throw new Error('dsh-rename: the session has no conversation text to name')
  }
  const route = resolveRoute(config, session)
  const messages = [createUserMessage({
    content: [{ type: 'text', text: frameTranscript(entries) }],
    source: { kind: 'dsh-rename' },
  })]
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const callSignal = AbortSignal.any([signal, timeout])
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system: systemPrompt(config),
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose: 'session-title',
    signal: callSignal,
  })
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of ctx.llm.stream(options) as AsyncIterable<StreamChunk>) {
      callSignal.throwIfAborted()
      assembler.push(chunk)
    }
  } catch (error: unknown) {
    if (timeout.aborted) {
      throw new Error(`dsh-rename: title generation timed out after ${config.timeoutMs}ms`, { cause: error })
    }
    throw error
  }
  callSignal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('dsh-rename: title output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const title = normalizeSessionTitle(text, config.maxTitleBytes)
  if (title.length === 0) throw new Error('dsh-rename: title model produced no text')
  return title
}
