import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as dshRename from '../src/index.ts'
import type { Config } from '../src/config.ts'

const sid = (id: string): SessionId => id as SessionId

const TITLE_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  构建会话重命名插件  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[] = TITLE_SCRIPT) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

/** Create a session whose transcript the title model can actually read. */
function seededSession(ctx: Context, id = 'rename-session'): Session {
  const session = ctx.sessions.create(sid(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '请帮我开发一个 DeepSeek Harness 的会话重命名插件' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: '我会先确认 DSH 是否已经内置自动命名，再实现 /rename 命令。' }],
      source: { provider: 'rename-test', model: 'rename-model' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function agentFor(session: Session): Agent {
  return { id: session.id, session } as Agent
}

interface Mounted {
  ctx: Context
  adapter: ScriptAdapter
  dispose: () => Promise<void>
}

async function mount(
  config: Config = { provider: 'rename-test', model: 'rename-model' },
  adapter: ScriptAdapter = new ScriptAdapter(),
): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 80,
  })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['rename-test'], adapter)
  const fiber = await ctx.plugin(dshRename, config)
  return { ctx, adapter, dispose: () => fiber.dispose() }
}

describe('/rename command registration', () => {
  it('registers the command with discovery metadata and removes it on disposal', async () => {
    const { ctx, dispose } = await mount()
    const session = seededSession(ctx, 'rename-registration')
    const agent = agentFor(session)
    expect(ctx.commands.find(agent, 'rename')).toMatchObject({
      name: 'rename',
      description: expect.stringContaining('pick a name'),
      recordInput: false,
    })
    expect(ctx.commands.list(agent).map(item => item.name)).toContain('rename')
    await dispose()
    expect(ctx.commands.find(agent, 'rename')).toBeUndefined()
  })

  it('rejects a provider/model pair that is only half configured', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SessionTitleService, {
      fallbackMaxWords: 5,
      fallbackMaxBytes: 40,
      maxTitleBytes: 80,
    })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(dshRename, { provider: 'rename-test' }))
      .rejects.toThrow(/provider and model must be supplied together/)
  })
})

describe('/rename with an explicit name', () => {
  it('renames immediately without dispatching an auxiliary model call', async () => {
    const { ctx, adapter } = await mount()
    const session = seededSession(ctx, 'rename-explicit')
    const execution = await ctx.commands.execute(agentFor(session), '/rename  手选会话名  ', [], new AbortController().signal)

    expect(execution?.result).toMatchObject({
      kind: 'success',
      text: 'Session renamed to "手选会话名".',
    })
    const title = session.snapshotEvents().findLast(event => event.type === 'session/title')
    expect(title?.data).toMatchObject({
      title: '手选会话名',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    expect(execution?.result.kind === 'success' && execution.result.sourceEventSeq).toBe(title?.seq)
    expect(adapter.requests).toHaveLength(0)
    // recordInput: false — the durable session/title event owns the payload.
    const run = session.snapshotEvents().find(event => event.type === 'command/run')
    expect(run?.type === 'command/run' && Object.hasOwn(run.data, 'args')).toBe(false)
  })

  it('reports a title that normalizes to empty as a command error', async () => {
    const { ctx, adapter } = await mount()
    const session = seededSession(ctx, 'rename-empty')
    // U+200B survives String.trim but normalizes to empty host-side.
    const execution = await ctx.commands.execute(agentFor(session), `/rename ${'\u200B'}`, [], new AbortController().signal)

    expect(execution?.result).toMatchObject({ kind: 'error' })
    expect(execution?.result.kind === 'error' && execution.result.text).toContain('Usage: /rename [<name>]')
    expect(adapter.requests).toHaveLength(0)
  })
})

describe('/rename without a name', () => {
  it('asks the model for a title, renames, and links the command card to the title event', async () => {
    const { ctx, adapter } = await mount()
    const session = seededSession(ctx, 'rename-generated')
    const execution = await ctx.commands.execute(agentFor(session), '/rename', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    const title = session.snapshotEvents().findLast(event => event.type === 'session/title')
    expect(title?.data).toMatchObject({
      title: '构建会话重命名插件',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    expect(execution?.result.kind === 'success' && execution.result.sourceEventSeq).toBe(title?.seq)

    const request = adapter.requests[0]
    expect(request).toMatchObject({
      provider: 'rename-test',
      model: 'rename-model',
      maxTokens: 64,
      purpose: 'session-title',
      sessionId: session.id,
    })
    expect(request?.system).toContain('coding-assistant session')
    expect(request?.messages[0]?.content[0]?.type).toBe('text')
    const framed = request?.messages[0]?.content[0]?.type === 'text' ? request.messages[0].content[0].text : ''
    expect(framed).toContain('DeepSeek Harness')
    expect(framed).toContain('/rename')
  })

  it('does not append a duplicate title event when the model returns the current title', async () => {
    const { ctx, adapter } = await mount()
    const session = seededSession(ctx, 'rename-duplicate')
    ctx.sessionTitle.rename(session, '构建会话重命名插件')
    const before = session.snapshotEvents().filter(event => event.type === 'session/title').length

    const execution = await ctx.commands.execute(agentFor(session), '/rename', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'success' })
    expect(execution?.result.kind === 'success' && execution.result.text).toContain('already named')
    expect(session.snapshotEvents().filter(event => event.type === 'session/title').length).toBe(before)
    expect(adapter.requests).toHaveLength(1)
  })

  it('falls back to the logged request route when no explicit route is configured', async () => {
    const logged = new ScriptAdapter()
    const { ctx } = await mount({})
    ctx.llm.registerAdapter(['logged-route'], logged)
    const session = seededSession(ctx, 'rename-route-fallback')
    session.append('request/header', {
      header: { config: { provider: 'logged-route', model: 'logged-model' } },
      reason: 'initial',
    })

    const execution = await ctx.commands.execute(agentFor(session), '/rename', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(logged.requests[0]).toMatchObject({ provider: 'logged-route', model: 'logged-model' })
  })

  it('reports an error result when the session has no conversation text', async () => {
    const { ctx, adapter } = await mount()
    const session = ctx.sessions.create(sid('rename-no-text'))
    const execution = await ctx.commands.execute(agentFor(session), '/rename', [], new AbortController().signal)

    expect(execution?.result).toMatchObject({ kind: 'error' })
    expect(execution?.result.kind === 'error' && execution.result.text).toContain('no conversation text')
    expect(adapter.requests).toHaveLength(0)
  })

  it('contains a provider failure as a command error result', async () => {
    class FailingAdapter extends ScriptAdapter {
      override async * stream(): AsyncGenerator<StreamChunk> {
        throw new Error('provider exploded')
      }
    }
    const { ctx } = await mount(
      { provider: 'rename-test', model: 'rename-model' },
      new FailingAdapter(),
    )
    const session = seededSession(ctx, 'rename-provider-failure')
    const execution = await ctx.commands.execute(agentFor(session), '/rename', [], new AbortController().signal)

    expect(execution?.result).toMatchObject({ kind: 'error' })
    expect(execution?.result.kind === 'error' && execution.result.text).toContain('provider exploded')
  })
})
