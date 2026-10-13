import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  collectTranscriptEntries,
  fitTranscript,
  textOfContent,
  type TranscriptEntry,
} from '../src/title.ts'

const sid = (id: string): SessionId => id as SessionId

/** Create one live session with a realistic two-turn transcript. */
function transcriptSession(ctx: Context, id = 'transcript'): Session {
  const session = ctx.sessions.create(sid(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '  Build a rename plugin  ' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'hidden planning that must not title the session' },
        { type: 'text', text: 'I will build it now.' },
      ],
      source: { provider: 'mock', model: 'mock' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '用中文写 README' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return session
}

describe('textOfContent', () => {
  it('joins visible text blocks and skips reasoning and unknown future blocks', () => {
    const text = textOfContent([
      { type: 'text', text: ' first ' },
      { type: 'reasoning', text: 'skip' },
      { type: 'text', text: 'second' },
      { type: 'future-block', marker: true } as never,
    ])
    expect(text).toBe('first \nsecond')
  })
})

describe('collectTranscriptEntries', () => {
  it('collects only direct human prompts and assistant replies in log order', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = transcriptSession(ctx)
    // A synthetic context injection must not leak into the transcript.
    session.append('turn/start', { turn: 3 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'SYNTHETIC CONTEXT' }],
      source: { kind: 'dsh-rename' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    expect(collectTranscriptEntries(session)).toEqual([
      { role: 'user', text: 'Build a rename plugin' },
      { role: 'assistant', text: 'I will build it now.' },
      { role: 'user', text: '用中文写 README' },
    ])
  })

  it('returns an empty list when a session has no visible conversation text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(sid('empty-transcript'))
    expect(collectTranscriptEntries(session)).toEqual([])
  })
})

describe('fitTranscript', () => {
  const entries: TranscriptEntry[] = [
    { role: 'user', text: 'oldest entry that must be dropped first' },
    { role: 'assistant', text: 'middle entry' },
    { role: 'user', text: 'latest entry' },
  ]

  it('keeps the complete list when it fits', () => {
    expect(fitTranscript(entries, 1024)).toEqual(entries)
  })

  it('drops whole oldest entries until the framed JSON fits', () => {
    const twoBytes = Buffer.byteLength(JSON.stringify(entries.slice(1)), 'utf8')
    const fitted = fitTranscript(entries, twoBytes)
    expect(fitted).toEqual(entries.slice(1))
  })

  it('truncates one oversized entry on code-point boundaries', () => {
    const single: TranscriptEntry = { role: 'user', text: '标题内容'.repeat(40) }
    const fitted = fitTranscript([single], 64)
    expect(fitted).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(64)
    expect(fitted[0]?.text.endsWith('…')).toBe(true)
  })

  it('returns an empty list for empty input', () => {
    expect(fitTranscript([], 64)).toEqual([])
  })

  it('rejects a non-positive budget', () => {
    expect(() => fitTranscript(entries, 0)).toThrow(/positive integer/)
  })
})
