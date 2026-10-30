import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Load the browser half under a stubbed module loader.
 *
 * The panel renders in a real browser, but everything that can break before the
 * first paint — module shape, slot registration, the React imports — is
 * checkable here. Component bodies themselves are not executed.
 */

const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition)
    },
  },
}

const styled = new Set()
globalThis.document = {
  createElement: () => ({ dataset: {}, style: {}, remove() {} }),
  head: {
    appendChild(element) {
      styled.add(element)
    },
  },
}

function reactStub() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
}

await import('../client.js')

test('the client module registers itself under the plugin id', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-plugin-kefu')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('applying the client half registers the panel and the sidebar entry', () => {
  const registrations = []
  const effects = []
  const factory = loaded[0].factory
  const module = factory((name) => {
    if (name === 'react') return reactStub()
    throw new Error(`unexpected require: ${name}`)
  })

  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')

  const ctx = {
    effect(fn) {
      effects.push(fn)
      const disposer = fn()
      return () => disposer?.()
    },
    slots: {
      inject(scope, callback) {
        registrations.push({ scope, registered: callback() })
      },
      register(target, component) {
        return { target, component }
      },
    },
  }

  module.apply(ctx)

  const scopes = registrations.map((item) => item.scope)
  assert.deepEqual(scopes, ['main', 'sidebar.panellist'])
  assert.equal(registrations[0].registered.target.name, 'main')
  assert.equal(registrations[0].registered.target.key, 'kefu')
  assert.equal(typeof registrations[0].registered.component, 'function')
  assert.equal(registrations[1].registered.target.id, 'kefu')
  assert.equal(typeof registrations[1].registered.target.label(), 'string')
  assert.equal(typeof registrations[1].registered.component, 'function', 'sidebar needs an icon component')
  assert.ok(effects.length >= 1)
  assert.ok(styled.size >= 1, 'panel styles are injected once')
})

test('the module can be applied twice without throwing (hot reload)', () => {
  const factory = loaded[0].factory
  const module = factory((name) => {
    if (name === 'react') return reactStub()
    throw new Error(`unexpected require: ${name}`)
  })
  const ctx = {
    effect: (fn) => fn(),
    slots: { inject: (_scope, callback) => callback(), register: () => ({}) },
  }
  assert.doesNotThrow(() => module.apply(ctx))
  assert.doesNotThrow(() => module.apply(ctx))
})
