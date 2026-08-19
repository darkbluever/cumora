/**
 * The embeddings channel is configured independently of the agent/chat channel
 * so a deployment can point OPENAI_BASE_URL at a gateway that proxies
 * `/v1/responses` but serves no `/v1/embeddings` route without silently losing
 * semantic memory. These tests pin the fallback chain — in particular that an
 * unset base URL stays `undefined` rather than becoming `''`, which is what
 * lets the OpenAI SDK keep resolving OPENAI_BASE_URL → api.openai.com.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-embeddings-channel.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEmbeddingClientOptions } from '../agents/embeddings.js'

test('unset EMBEDDING_* falls back to the OpenAI channel, baseURL undefined', () => {
  const o = resolveEmbeddingClientOptions({
    EMBEDDING_API_KEY: '',
    EMBEDDING_BASE_URL: '',
    OPENAI_API_KEY: 'sk-openai',
  })
  assert.equal(o.apiKey, 'sk-openai')
  // Must be absent, NOT ''. An empty string is a literal base URL to the SDK
  // and would break every embeddings request instead of falling through.
  assert.equal(o.baseURL, undefined)
  assert.equal('baseURL' in o && o.baseURL === undefined, true)
})

test('EMBEDDING_BASE_URL alone splits the channel but keeps the OpenAI key', () => {
  const o = resolveEmbeddingClientOptions({
    EMBEDDING_API_KEY: '',
    EMBEDDING_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_API_KEY: 'sk-openai',
  })
  assert.equal(o.baseURL, 'https://openrouter.ai/api/v1')
  assert.equal(o.apiKey, 'sk-openai')
})

test('EMBEDDING_API_KEY overrides OPENAI_API_KEY', () => {
  const o = resolveEmbeddingClientOptions({
    EMBEDDING_API_KEY: 'sk-embed',
    EMBEDDING_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_API_KEY: 'sk-openai',
  })
  assert.equal(o.apiKey, 'sk-embed')
  assert.equal(o.baseURL, 'https://openrouter.ai/api/v1')
})
