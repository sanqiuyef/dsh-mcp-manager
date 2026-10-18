#!/usr/bin/env node
/**
 * Offline self-check for the dsh-mcp-manager browser half.
 *
 * Runs `client/client.js` inside a Node `vm` sandbox that mimics the browser
 * module loader (`window.__ModuleLoader__.load`) and the two services the
 * plugin injects (`slots`, `locale`). It asserts:
 *
 *  1. the module bootstraps through `window.__ModuleLoader__.load` exactly once
 *     with id `dsh-mcp-manager`, and exposes `{ inject, apply }`;
 *  2. loading the module is side-effect free: no DOM access, no `fetch`, no
 *     timers before `apply()` is called;
 *  3. `apply(ctx)` registers exactly one `settings.section` entry with
 *     `id: 'mcp-manager'`, `order: 30`, `locale: 'mcpManager'` and a localized
 *     `label()` that follows the active locale;
 *  4. the locale namespace registers complete, key-identical `zh`/`en`
 *     dictionaries;
 *  5. the page component is handed to the slot registration untouched (the
 *     framework renders it, not this module);
 *  6. `apply()` installs the self-contained stylesheet and never fetches;
 *  7. the same flow works in an environment with no `document` at all
 *     (defensive boot, e.g. non-browser hosts).
 *
 * Usage:  D:\nodejs\node.exe client/selfcheck.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, 'client.js')
const source = readFileSync(sourcePath, 'utf8')

const PLUGIN_ID = 'dsh-mcp-manager'
const failures = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function check(name, fn) {
  try {
    const detail = fn()
    console.log('ok   ' + name + (detail ? '  [' + detail + ']' : ''))
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL ' + name)
    console.log('     ' + (error && error.message ? error.message : String(error)))
  }
}

/* ------------------------------------------------------------------ *
 * Fake React (only the surface client.js touches)
 * ------------------------------------------------------------------ */

function createReactStub(counts) {
  function createElement() {
    counts.render += 1
    return { type: arguments[0], props: {} }
  }
  return {
    createElement,
    Fragment: Symbol.for('react.fragment'),
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, function noop() {}]
    },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
    useReducer(reducer, initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, function noop() {}]
    },
    memo(fn) {
      return fn
    },
    createContext(defaultValue) {
      return { Provider: null, Consumer: null, defaultValue }
    },
    forwardRef(fn) {
      return fn
    },
  }
}

/* ------------------------------------------------------------------ *
 * Fake locale service
 * ------------------------------------------------------------------ */

function createLocaleService() {
  const dictionaries = new Map()
  const listeners = new Set()
  const state = { active: 'zh' }

  function translate(namespace) {
    return function t(key, vars) {
      const bag = dictionaries.get(namespace)
      if (!bag) return key
      const preferred = bag[state.active] || {}
      const fallback = bag.en || {}
      const raw = Object.prototype.hasOwnProperty.call(preferred, key) ? preferred[key] : fallback[key]
      if (raw === undefined) return key
      if (!vars) return String(raw)
      return String(raw).replace(/\{(\w+)\}/g, function (match, name) {
        return vars[name] == null ? match : String(vars[name])
      })
    }
  }

  return {
    register(namespace, bag) {
      if (dictionaries.has(namespace)) throw new Error('duplicate locale namespace: ' + namespace)
      dictionaries.set(namespace, Object.assign({}, bag))
      listeners.forEach(function (listener) {
        listener()
      })
      return function dispose() {
        dictionaries.delete(namespace)
      }
    },
    bind(namespace) {
      return translate(namespace)
    },
    getSnapshot() {
      return { active: state.active, revision: dictionaries.size, locales: [] }
    },
    subscribe(listener) {
      listeners.add(listener)
      return function unsubscribe() {
        listeners.delete(listener)
      }
    },
    setActive(next) {
      state.active = next
      listeners.forEach(function (listener) {
        listener()
      })
    },
    dictionaries,
    state,
  }
}

/* ------------------------------------------------------------------ *
 * Fake slots service
 * ------------------------------------------------------------------ */

function createSlotsService(log) {
  const entries = []
  return {
    inject(name, callback) {
      log.injections.push(name)
      const disposer = callback()
      return disposer
    },
    register(options, component) {
      entries.push({ options: options, component: component })
      log.registrations.push({ options: options, component: component })
      return function dispose() {}
    },
    entries() {
      return entries
    },
    getVersion() {
      return entries.length
    },
  }
}

/* ------------------------------------------------------------------ *
 * Sandbox runner
 * ------------------------------------------------------------------ */

function runSandbox(options) {
  const config = options || {}
  const log = {
    loads: [],
    injections: [],
    registrations: [],
    effects: [],
    dom: [],
    fetches: [],
    timers: [],
    counts: { render: 0 },
  }

  const reactStub = createReactStub(log.counts)
  const locale = createLocaleService()
  const sandbox = {
    console: console,
    setTimeout(fn, ms) {
      log.timers.push(ms)
      return 0
    },
    clearTimeout() {},
    fetch() {
      log.fetches.push(Array.prototype.slice.call(arguments))
      return Promise.reject(new Error('network is disabled in selfcheck'))
    },
    AbortController: class {
      constructor() {
        this.signal = { aborted: false }
      }
      abort() {
        this.signal.aborted = true
      }
    },
    Blob: class {},
    URL: { createObjectURL: function () { return 'blob:selfcheck' }, revokeObjectURL: function () {} },
    FileReader: class {},
    window: {
      __ModuleLoader__: {
        load(definition) {
          log.loads.push(definition)
        },
      },
    },
  }

  if (config.document !== false) {
    const head = {
      appendChild(node) {
        log.dom.push(['appendChild'])
        node.parentNode = head
        return node
      },
    }
    sandbox.document = {
      querySelector(selector) {
        log.dom.push(['querySelector', selector])
        return null
      },
      createElement(tag) {
        log.dom.push(['createElement', tag])
        return { tagName: String(tag).toUpperCase(), dataset: {}, textContent: '', parentNode: null }
      },
      head: head,
      body: head,
      addEventListener() {},
      removeEventListener() {},
    }
  }

  const context = vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(context)

  assert(log.loads.length === 1, 'expected exactly one ModuleLoader.load call, got ' + log.loads.length)
  const definition = log.loads[0]
  assert(definition && typeof definition === 'object', 'ModuleLoader.load received no definition')
  assert(definition.id === PLUGIN_ID, 'module id mismatch: ' + String(definition.id))
  assert(typeof definition.factory === 'function', 'definition.factory is not a function')

  const loadState = {
    dom: log.dom.length,
    fetches: log.fetches.length,
    timers: log.timers.length,
    renders: log.counts.render,
  }

  const exported = definition.factory(function requireStub(name) {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  })

  const ctx = {
    effect(fn, label) {
      log.effects.push({ label: label, disposer: typeof fn === 'function' ? fn() : undefined })
      return function dispose() {}
    },
    slots: createSlotsService(log),
    locale: locale,
  }

  return { exported: exported, ctx: ctx, log: log, locale: locale, loadState: loadState, definition: definition }
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

console.log('# dsh-mcp-manager client selfcheck')
console.log('# source: ' + sourcePath)
console.log('')

let main = null

check('module loads through window.__ModuleLoader__.load with the plugin id', () => {
  main = runSandbox({})
  return PLUGIN_ID
})

check('factory returns { inject, apply } with the declared services', () => {
  assert(main, 'module did not load')
  assert(main.exported && typeof main.exported === 'object', 'factory did not return an object')
  assert(typeof main.exported.apply === 'function', 'apply is not a function')
  assert(Array.isArray(main.exported.inject), 'inject is not an array')
  const expected = ['slots', 'locale']
  assert(
    main.exported.inject.length === expected.length && expected.every((name, index) => main.exported.inject[index] === name),
    'inject mismatch: ' + JSON.stringify(main.exported.inject),
  )
  return main.exported.inject.join(',')
})

check('loading the module has no side effects (no DOM / fetch / timer / render)', () => {
  assert(main, 'module did not load')
  const state = main.loadState
  assert(state.dom === 0, 'module touched the DOM while loading (' + state.dom + ' calls)')
  assert(state.fetches === 0, 'module called fetch while loading')
  assert(state.timers === 0, 'module scheduled a timer while loading')
  assert(state.renders === 0, 'module rendered React elements while loading')
  return 'dom=0 fetch=0 timers=0'
})

check('apply() waits on the settings.section slot', () => {
  assert(main.exported && typeof main.exported.apply === 'function', 'apply missing')
  main.exported.apply(main.ctx)
  assert(main.log.injections.length === 1, 'expected exactly one slot injection, got ' + main.log.injections.length)
  assert(main.log.injections[0] === 'settings.section', 'injected slot mismatch: ' + main.log.injections[0])
  return main.log.injections[0]
})

check('registers one settings.section entry with id/order/locale', () => {
  assert(main.log.registrations.length === 1, 'expected exactly one registration, got ' + main.log.registrations.length)
  const entry = main.log.registrations[0]
  const options = entry.options || {}
  assert(options.name === 'settings.section', 'name mismatch: ' + String(options.name))
  assert(options.id === 'mcp-manager', 'id mismatch: ' + String(options.id))
  assert(options.order === 30, 'order mismatch: ' + String(options.order))
  assert(options.locale === 'mcpManager', 'locale mismatch: ' + String(options.locale))
  assert(typeof options.label === 'function', 'label is not a function')
  assert(typeof entry.component === 'function', 'page component is not a function')
  return 'id=' + options.id + ' order=' + options.order + ' locale=' + options.locale
})

check('nav label follows the active locale', () => {
  const options = main.log.registrations[0].options
  const zh = options.label()
  assert(zh === 'MCP 服务器', 'zh nav label mismatch: ' + String(zh))
  main.locale.setActive('en')
  const en = options.label()
  assert(en === 'MCP Servers', 'en nav label mismatch: ' + String(en))
  main.locale.setActive('zh')
  return 'zh="' + zh + '" en="' + en + '"'
})

check('locale namespace registers complete zh/en dictionaries', () => {
  const bag = main.locale.dictionaries.get('mcpManager')
  assert(bag, 'locale namespace mcpManager was not registered')
  assert(bag.zh && typeof bag.zh === 'object', 'zh dictionary missing')
  assert(bag.en && typeof bag.en === 'object', 'en dictionary missing')
  const zhKeys = Object.keys(bag.zh)
  const enKeys = Object.keys(bag.en)
  assert(zhKeys.length > 60, 'unexpectedly small dictionary: ' + zhKeys.length + ' keys')
  assert(zhKeys.length === enKeys.length, 'dictionary size mismatch: zh=' + zhKeys.length + ' en=' + enKeys.length)
  const missingInEn = zhKeys.filter((key) => !Object.prototype.hasOwnProperty.call(bag.en, key))
  const missingInZh = enKeys.filter((key) => !Object.prototype.hasOwnProperty.call(bag.zh, key))
  assert(missingInEn.length === 0, 'keys missing in en: ' + missingInEn.join(', '))
  assert(missingInZh.length === 0, 'keys missing in zh: ' + missingInZh.join(', '))
  const nonString = zhKeys.filter((key) => typeof bag.zh[key] !== 'string' || typeof bag.en[key] !== 'string')
  assert(nonString.length === 0, 'non-string entries: ' + nonString.join(', '))
  const empty = zhKeys.filter((key) => bag.zh[key].length === 0 || bag.en[key].length === 0)
  assert(empty.length === 0, 'empty entries: ' + empty.join(', '))
  return zhKeys.length + ' keys x 2 locales'
})

check('apply() installs the self-contained stylesheet', () => {
  const dom = main.log.dom
  assert(dom.some((call) => call[0] === 'createElement' && call[1] === 'style'), 'no <style> element was created')
  assert(dom.some((call) => call[0] === 'appendChild'), 'the stylesheet was not appended to <head>')
  const query = dom.filter((call) => call[0] === 'querySelector')
  assert(query.length > 0, 'style deduplication selector was not queried')
  assert(query[0][1].indexOf('data-plugin-css') >= 0, 'style guard selector is not the plugin-css one: ' + query[0][1])
  return 'style injected once'
})

check('apply() performs no network access', () => {
  assert(main.log.fetches.length === 0, 'apply() called fetch ' + main.log.fetches.length + ' time(s)')
  return 'fetch=0'
})

check('effect cleanups are registered for dictionaries and styles', () => {
  const labels = main.log.effects.map((effect) => effect.label)
  assert(labels.length >= 2, 'expected at least two effects, got ' + labels.length)
  assert(labels.some((label) => String(label).indexOf('dictionaries') >= 0), 'dictionary effect missing: ' + labels.join(', '))
  assert(labels.some((label) => String(label).indexOf('styles') >= 0), 'style effect missing: ' + labels.join(', '))
  const disposers = main.log.effects.filter((effect) => typeof effect.disposer === 'function')
  assert(disposers.length >= 1, 'no effect returned a disposer')
  return labels.join(' | ')
})

check('boots and applies without a document (non-browser host)', () => {
  const headless = runSandbox({ document: false })
  assert(headless.exported && typeof headless.exported.apply === 'function', 'headless factory result is invalid')
  headless.exported.apply(headless.ctx)
  assert(headless.log.registrations.length === 1, 'headless apply did not register the section')
  assert(headless.log.registrations[0].options.id === 'mcp-manager', 'headless registration id mismatch')
  assert(headless.log.fetches.length === 0, 'headless apply fetched the network')
  return 'no document required'
})

check('module only exports the plugin face', () => {
  const keys = Object.keys(main.exported)
  assert(keys.length === 2, 'unexpected export surface: ' + keys.join(', '))
  assert(keys.indexOf('apply') >= 0 && keys.indexOf('inject') >= 0, 'missing plugin face keys: ' + keys.join(', '))
  return keys.join(',')
})

console.log('')
if (failures.length) {
  console.log('FAILED: ' + failures.length + ' check(s) failed.')
  process.exit(1)
}
console.log('PASSED: all checks green (' + source.split('\n').length + ' lines of client.js).')
