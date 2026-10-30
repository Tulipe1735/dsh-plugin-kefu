/**
 * Channel registry.
 *
 * Each adapter owns one transport. Three kinds exist on purpose:
 *   - `official`  : 淘宝 TOP / 京东 JOS gateways — replies really are delivered.
 *   - `bridge`    : a local helper pulls the outbox; the merchant owns capture.
 *   - `webhook`   : an external tool posts messages in and receives replies out.
 *
 * None of them hook a desktop client: that path is unshippable (see README).
 */
import { createAdapter as createBridge } from './bridge.js'
import { createAdapter as createJingmai } from './jingmai.js'
import { createAdapter as createQianniu } from './qianniu.js'
import { createAdapter as createWebhook } from './webhook.js'

export const CHANNEL_FACTORIES = {
  qianniu: createQianniu,
  jingmai: createJingmai,
  bridge: createBridge,
  webhook: createWebhook,
}

export function createChannelRegistry({ getConfig, logger }) {
  const adapters = new Map()
  for (const [id, factory] of Object.entries(CHANNEL_FACTORIES)) {
    adapters.set(
      id,
      factory({
        getConfig: () => getConfig().channels[id],
        logger,
      }),
    )
  }
  return {
    get(id) {
      const adapter = adapters.get(id)
      if (!adapter) throw new Error(`未知通道：${id}`)
      return adapter
    },
    has(id) {
      return adapters.has(id)
    },
    ids() {
      return [...adapters.keys()]
    },
    list() {
      return [...adapters.values()]
    },
    statuses() {
      return [...adapters.values()].map((adapter) => {
        try {
          return adapter.status()
        } catch (error) {
          return { id: adapter.id, label: adapter.label, enabled: false, ready: false, detail: String(error) }
        }
      })
    },
  }
}
