/**
 * DeepSeek API composer for the standalone daemon.
 *
 * The DSH plugin borrows the host's `llm` service; a daemon has no host, so it
 * talks to the DeepSeek chat-completions endpoint directly. Everything else —
 * the grounding check, the sensitive-word screen, the template fallback — stays
 * in `lib/`, so the daemon cannot answer differently from the plugin.
 */
const DEFAULT_BASE = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-chat'

export function createDeepSeekComposer({ apiKey, baseUrl = DEFAULT_BASE, model = DEFAULT_MODEL, logger } = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('缺少 DeepSeek API Key：设置 DEEPSEEK_API_KEY 环境变量后再启动守护进程')
  }
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

  return async function compose({ system, input, maxTokens = 400, timeoutMs = 20_000, signal }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.3,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: input },
          ],
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300)
        throw new Error(`DeepSeek API 返回 HTTP ${response.status}：${detail}`)
      }
      const payload = await response.json()
      const text = payload?.choices?.[0]?.message?.content ?? ''
      if (typeof text !== 'string' || text.trim() === '') throw new Error('DeepSeek API 返回了空内容')
      return { text, provider: 'deepseek', model: payload?.model ?? model }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`DeepSeek API 超时（${timeoutMs}ms）`)
      logger?.warn?.(`kefu-daemon: 模型调用失败，回退模板：${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }
}

export { DEFAULT_BASE, DEFAULT_MODEL }
