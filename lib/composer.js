/**
 * Model-backed reply composition.
 *
 * The desk never lets a model roam free: retrieval has already decided that the
 * catalog contains the answer, and the model is only allowed to *phrase* those
 * facts for a buyer. The system prompt says so, and the caller re-checks the
 * output (numbers must exist in the evidence, sensitive words and platform red
 * lines still apply) before a single character reaches a customer.
 *
 * When the profile has no `llm` service — or the configured route fails — the
 * caller falls back to the deterministic template, so the plugin still works in
 * a headless profile.
 */
import { randomUUID } from 'node:crypto'

const CACHE_MS = 30_000

export function hasLlm(llm) {
  return Boolean(llm) && typeof llm.prepareCall === 'function'
}

function providerId(entry) {
  if (typeof entry === 'string') return entry
  return entry?.id ?? entry?.provider ?? entry?.name ?? ''
}

async function safeCall(fn) {
  try {
    return await fn()
  } catch {
    return null
  }
}

/**
 * @param {{getLlm: () => unknown, logger?: {warn?: Function, debug?: Function}}} options
 */
export function createComposer({ getLlm, logger }) {
  let cache = null
  let cacheAt = 0
  let lastError = null

  async function catalog() {
    const llm = getLlm()
    if (!hasLlm(llm)) return { available: false, providers: [] }
    if (cache && Date.now() - cacheAt < CACHE_MS) return cache
    const raw = (await safeCall(() => llm.listProviders())) ?? []
    const providers = []
    for (const entry of Array.isArray(raw) ? raw : []) {
      const id = providerId(entry)
      if (id === '') continue
      const models = (await safeCall(() => llm.listModels(id))) ?? []
      providers.push({
        provider: id,
        label: entry?.name ?? entry?.label ?? id,
        models: (Array.isArray(models) ? models : []).map((model) => ({
          model: String(model?.id ?? model?.model ?? ''),
          label: String(model?.name ?? model?.id ?? ''),
        })).filter((item) => item.model !== ''),
      })
    }
    cache = { available: true, providers }
    cacheAt = Date.now()
    return cache
  }

  return {
    async status() {
      const list = await catalog()
      return { ...list, llm: hasLlm(getLlm()), lastError }
    },

    async route(preferred = {}) {
      const list = await catalog()
      if (!list.available) return null
      const preferredProvider =
        preferred.provider === undefined || preferred.provider === ''
          ? null
          : (list.providers.find((item) => item.provider === preferred.provider) ?? null)
      // An explicit provider+model pair wins even when the catalog is empty
      // (some adapters only accept a concrete model id).
      if (preferredProvider !== null && preferred.model !== undefined && preferred.model !== '') {
        return { provider: preferredProvider.provider, model: preferred.model }
      }
      // Providers that advertise no catalog (e.g. an account route that only
      // accepts configured ids) must not shadow one that does.
      const usable = list.providers.filter((item) => item.models.length > 0)
      const provider = preferredProvider !== null && preferredProvider.models.length > 0 ? preferredProvider : usable[0]
      if (provider === undefined || provider === null) return null
      const model = provider.models.find((item) => item.model === preferred.model)?.model ?? provider.models[0]?.model
      if (model === undefined || model === '') return null
      return { provider: provider.provider, model }
    },

    /**
     * Stream one completion and return its text.
     *
     * @throws when the route is unavailable, the model errors, or the deadline
     *         expires — callers are expected to fall back, not to retry blindly.
     */
    async compose({ system, input, provider, model, maxTokens = 400, timeoutMs = 20_000, signal }) {
      const llm = getLlm()
      if (!hasLlm(llm)) throw new Error('当前 profile 没有 llm 服务')
      const route = await this.route({ provider, model })
      if (route === null) throw new Error('没有可用的模型路由，请在设置里选一个 provider / model')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = () => controller.abort()
      signal?.addEventListener?.('abort', onAbort)
      try {
        const call = await llm.prepareCall({ ...route, maxTokens }, controller.signal)
        const messages = [
          {
            id: randomUUID(),
            role: 'user',
            source: { kind: 'dsh-plugin-kefu' },
            content: [{ type: 'text', text: input }],
          },
        ]
        let text = ''
        for await (const chunk of call.stream({
          ...call.config,
          messages,
          system,
          purpose: 'kefu-reply',
          signal: controller.signal,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
            throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
          }
          if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') {
            throw new Error('模型调用被中断')
          }
        }
        const trimmed = text.trim()
        if (trimmed === '') throw new Error('模型返回了空内容')
        lastError = null
        return { text: trimmed, provider: route.provider, model: route.model }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`kefu: 模型生成失败，回退模板：${lastError}`)
        throw error
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
      }
    },
  }
}

/** System prompt handed to the model. Hard rules, in the model's own words. */
export function replySystemPrompt({ product, citations, config }) {
  const evidence = citations.map((item) => `- ${item.label}：${item.value}`).join('\n')
  return [
    '你是电商店铺的客服，用简体中文回复买家。',
    '只能使用下面「证据」里出现的事实，禁止补充、推测、承诺任何证据之外的信息（价格、库存、时效、优惠、材质、售后政策都算）。',
    '禁止编造数字；如果证据里没有买家问的那一项，就回答：这个我需要让客服同事确认一下。',
    '不要提「证据」「知识库」「AI」这类词，不要加表情，不要问买家要联系方式，不要引导站外私下交易。',
    `回复要口语、简短（不超过 ${config.reply.maxChars} 字），只输出回复正文，不要加引号或解释。`,
    product ? `买家问的商品：${product.title}` : '',
    '证据：',
    evidence || '- （无）',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** Every number in the reply must be traceable to the evidence. */
export function numbersGrounded(text, citations) {
  const allowed = citations.map((item) => String(item.value ?? '')).join(' ')
  const numbers = String(text ?? '').match(/\d+(?:\.\d+)?/g) ?? []
  const invented = numbers.filter((number) => number.length >= 2 && !allowed.includes(number))
  return { ok: invented.length === 0, invented }
}
