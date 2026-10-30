import assert from 'node:assert/strict'
import test from 'node:test'

import { createComposer, hasLlm, numbersGrounded, replySystemPrompt } from '../lib/composer.js'

/** Minimal stand-in for the DSH llm service. */
function fakeLlm({ providers = ['deepseek'], models = ['deepseek-chat'], text = '亲，¥129。', fail = null } = {}) {
  const calls = []
  const llm = {
    calls,
    listProviders: () => providers.map((id) => ({ id, name: id })),
    listModels: async (provider) => models.map((id) => ({ provider, id, name: id })),
    async prepareCall(config) {
      calls.push({ config })
      return {
        config: { maxTokens: config.maxTokens, temperature: 0.3 },
        async *stream(options) {
          calls.push({ options })
          if (fail) throw new Error(fail)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  return llm
}

test('hasLlm detects a usable service', () => {
  assert.equal(hasLlm(null), false)
  assert.equal(hasLlm({}), false)
  assert.equal(hasLlm(fakeLlm()), true)
})

test('composer discovers providers and their models', async () => {
  const composer = createComposer({ getLlm: () => fakeLlm() })
  const status = await composer.status()
  assert.equal(status.available, true)
  assert.equal(status.llm, true)
  assert.deepEqual(status.providers[0], {
    provider: 'deepseek',
    label: 'deepseek',
    models: [{ model: 'deepseek-chat', label: 'deepseek-chat' }],
  })
})

test('composer streams text and respects a configured route', async () => {
  const llm = fakeLlm({ providers: ['deepseek', 'opencode-go'], models: ['m1'], text: '亲，这款 ¥129。' })
  const composer = createComposer({ getLlm: () => llm })
  const result = await composer.compose({
    system: 'sys',
    input: '买家消息：多少钱',
    provider: 'opencode-go',
    model: 'm1',
  })
  assert.equal(result.text, '亲，这款 ¥129。')
  assert.equal(result.provider, 'opencode-go')
  assert.equal(result.model, 'm1')
  assert.equal(llm.calls[1].options.system, 'sys')
  assert.equal(llm.calls[1].options.purpose, 'kefu-reply')
  assert.equal(llm.calls[1].options.messages[0].role, 'user')
  assert.equal(llm.calls[1].options.messages[0].content[0].text, '买家消息：多少钱')
})

test('a provider error surfaces so the caller can fall back', async () => {
  const composer = createComposer({ getLlm: () => fakeLlm({ fail: 'quota exceeded' }) })
  await assert.rejects(() => composer.compose({ system: 's', input: 'i' }), /quota exceeded/)
})

test('a provider with no catalog does not shadow one that has models', async () => {
  const llm = {
    listProviders: () => [{ id: 'empty' }, { id: 'deepseek' }],
    listModels: async (provider) => (provider === 'deepseek' ? [{ provider, id: 'deepseek-chat', name: 'chat' }] : []),
    prepareCall: async () => ({ config: {}, async *stream() {} }),
  }
  const composer = createComposer({ getLlm: () => llm })
  assert.deepEqual(await composer.route({}), { provider: 'deepseek', model: 'deepseek-chat' })
})

test('an explicit provider+model pair wins over the catalog', async () => {
  const composer = createComposer({ getLlm: () => fakeLlm() })
  assert.deepEqual(await composer.route({ provider: 'deepseek', model: 'pinned-model' }), {
    provider: 'deepseek',
    model: 'pinned-model',
  })
})

test('composer reports a missing service instead of throwing on status', async () => {
  const composer = createComposer({ getLlm: () => null })
  const status = await composer.status()
  assert.equal(status.available, false)
  assert.deepEqual(status.providers, [])
  assert.equal(await composer.route({}), null)
  await assert.rejects(() => composer.compose({ system: 's', input: 'i' }), /没有 llm 服务/)
})

test('numbers must come from the evidence', () => {
  const citations = [
    { field: 'price', label: '价格', value: '¥129' },
    { field: 'shipping', label: '发货', value: '48 小时内发出' },
  ]
  assert.equal(numbersGrounded('亲，这款 ¥129，48 小时内发出。', citations).ok, true)
  assert.equal(numbersGrounded('亲，这款 ¥99，48 小时内发出。', citations).ok, false)
  // Single digits are allowed: "7 天无理由" is too common to police.
  assert.equal(numbersGrounded('亲，7 天内可退，¥129。', citations).ok, true)
})

test('the system prompt frames the evidence and forbids invention', () => {
  const prompt = replySystemPrompt({
    product: { title: '纯棉短袖' },
    citations: [{ field: 'price', label: '价格', value: '¥129' }],
    config: { reply: { maxChars: 300 } },
  })
  assert.match(prompt, /只能使用下面「证据」里出现的事实/)
  assert.match(prompt, /- 价格：¥129/)
  assert.match(prompt, /买家问的商品：纯棉短袖/)
})
