import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  streamSimple.mockReset()
  await closeMockServers()
})

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

/**
 * A hand-declared `anthropic-messages` route pointed at the mock endpoint. The
 * real protocol implementation serves it, so the recorded request body is the
 * wire evidence for what the session options put there.
 */
function anthropicAdapter(baseURL: string, profile: Record<string, unknown>): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'acme-anthropic': {
        api: 'anthropic-messages',
        baseURL,
        models: [{ id: 'acme-model', contextWindow: 8192, maxTokens: 1024 }],
        ...profile,
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

/** One request through that route; the mock answers an empty stream, which finishes as an error. */
async function requestBody(profile: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
  const server = await mockServer([{ events: [] }])
  const adapter = anthropicAdapter(server.url, profile)
  for await (const _chunk of adapter.stream({
    provider: 'acme-anthropic',
    model: 'acme-model',
    messages: [],
    ...sessionId === undefined ? {} : { sessionId: sessionId as never },
  })) { /* the body is recorded before the first chunk; the outcome is not this test's subject */ }
  return server.requests[0] as Record<string, unknown>
}

describe('conversation identity on an anthropic-messages route', () => {
  it('names the session in metadata.user_id when the route asks for it', async () => {
    expect(await requestBody({ sendSessionUserId: true }, 'session-abc'))
      .toMatchObject({ metadata: { user_id: 'session_session-abc' } })
  })

  it('sends no metadata by default, so the session id stays inside the harness', async () => {
    expect(await requestBody({}, 'session-abc')).not.toHaveProperty('metadata')
  })

  it('sends no metadata for a request carrying no session, however the route is configured', async () => {
    expect(await requestBody({ sendSessionUserId: true })).not.toHaveProperty('metadata')
  })

  it('refuses the switch on a route no model of which speaks the protocol that carries it', () => {
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
        sendSessionUserId: true,
      },
    })).toThrow(/sendSessionUserId.*anthropic-messages.*metadata\.user_id/s)
  })
})

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })
})
