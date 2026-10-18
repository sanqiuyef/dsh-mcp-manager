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
 *     (defensive boot, e.g. non-browser hosts);
 *  8. `apply()` registers a `settings-nav glyph` effect after the styles
 *     effect, and that effect returns a disposer;
 *  9. without `MutationObserver` the decorator touches no DOM at all (the
 *     first `querySelector` stays the style dedupe selector);
 * 10. against a minimal settings panel it decorates only this plugin's own
 *     nav row (hiding the shipped gear, inserting one 16×16 glyph) and the
 *     disposer restores that row untouched.
 *
 * Usage:  node client/selfcheck.mjs
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
 * Minimal DOM stub for the settings-nav decorator
 *
 * Implements exactly what `installNavGlyph` / `decorateNavRow` (and the
 * stylesheet guard) call: attributes, children, inline style and a
 * descendant search. It is deliberately not a renderer and lays nothing out.
 * ------------------------------------------------------------------ */

function parseSimpleSelector(part) {
  const match = /^([a-zA-Z]*)(?:\[([^\]]+)\])?$/.exec(part)
  if (!match) throw new Error('unsupported selector: ' + part)
  let attr = null
  if (match[2]) {
    const pair = /^([^=]+)(?:=(.*))?$/.exec(match[2])
    attr = {
      name: pair[1],
      value: pair[2] === undefined ? null : pair[2].replace(/^["']|["']$/g, ''),
    }
  }
  return { tag: match[1] ? match[1].toUpperCase() : null, attr: attr }
}

function simpleSelectorMatches(node, part) {
  if (!node || !node.tagName) return false
  if (part.tag && node.tagName !== part.tag) return false
  if (part.attr) {
    const value = node.getAttribute(part.attr.name)
    if (value === null) return false
    if (part.attr.value !== null && value !== part.attr.value) return false
  }
  return true
}

/** `tag`, `[attr]`, `[attr="value"]`, `tag[attr]`, and `a b` descendants. */
function selectorMatches(node, selector) {
  const parts = String(selector).trim().split(/\s+/).map(parseSimpleSelector)
  let current = node
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (i === parts.length - 1) {
      if (!simpleSelectorMatches(current, parts[i])) return false
      continue
    }
    current = current.parentNode
    while (current && !simpleSelectorMatches(current, parts[i])) current = current.parentNode
    if (!current) return false
  }
  return true
}

function createStubElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    attributes: {},
    textContent: '',
    setAttribute(name, value) {
      element.attributes[String(name)] = String(value)
    },
    getAttribute(name) {
      const key = String(name)
      return Object.prototype.hasOwnProperty.call(element.attributes, key) ? element.attributes[key] : null
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(element.attributes, String(name))
    },
    removeAttribute(name) {
      delete element.attributes[String(name)]
    },
    appendChild(child) {
      child.parentNode = element
      element.children.push(child)
      return child
    },
    insertBefore(child, reference) {
      const index = element.children.indexOf(reference)
      child.parentNode = element
      if (index < 0) element.children.push(child)
      else element.children.splice(index, 0, child)
      return child
    },
    removeChild(child) {
      const index = element.children.indexOf(child)
      if (index >= 0) element.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    descendants() {
      const out = []
      const visit = function (node) {
        for (let i = 0; i < node.children.length; i += 1) {
          out.push(node.children[i])
          visit(node.children[i])
        }
      }
      visit(element)
      return out
    },
    querySelectorAll(selector) {
      return element.descendants().filter(function (node) {
        return selectorMatches(node, selector)
      })
    },
    querySelector(selector) {
      const found = element.querySelectorAll(selector)
      return found.length ? found[0] : null
    },
  }
  return element
}

/**
 * A settings panel shaped like the shell's: one nav row whose label is this
 * plugin's zh nav copy and one decoy row. `labels` is [own, decoy].
 */
function createNavDomStub(labels) {
  const body = createStubElement('body')
  const panel = createStubElement('div')
  panel.setAttribute('data-shortcut-modal', 'settings')
  const nav = createStubElement('nav')
  body.appendChild(panel)
  panel.appendChild(nav)

  function navRow(labelText) {
    const button = createStubElement('button')
    const gear = createStubElement('svg')
    gear.setAttribute('class', 'navIcon')
    const label = createStubElement('span')
    label.textContent = labelText
    button.appendChild(gear)
    button.appendChild(label)
    nav.appendChild(button)
    return { button: button, gear: gear, label: label }
  }

  const mine = navRow(labels[0])
  const decoy = navRow(labels[1])

  const document = {
    body: body,
    head: createStubElement('head'),
    createElement(tag) {
      return createStubElement(tag)
    },
    createElementNS(namespace, tag) {
      return createStubElement(tag)
    },
    querySelector(selector) {
      return body.querySelector(selector)
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector)
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const observers = []
  class MutationObserver {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe(target, options) {
      this.target = target
      this.options = options
    }
    disconnect() {
      this.disconnected = true
    }
  }

  return {
    document: document,
    MutationObserver: MutationObserver,
    body: body,
    panel: panel,
    nav: nav,
    mine: mine,
    decoy: decoy,
    observers: observers,
  }
}

/* ------------------------------------------------------------------ *
 * Sandbox runner
 * ------------------------------------------------------------------ */

function runSandbox(options) {
  const config = options || {}
  let navDom = null
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
    if (config.navDom === true) {
      navDom = createNavDomStub(config.navLabels || ['MCP 服务器', 'MCP Servers'])
      sandbox.document = navDom.document
      sandbox.MutationObserver = navDom.MutationObserver
    } else {
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

  return { exported: exported, ctx: ctx, log: log, locale: locale, loadState: loadState, definition: definition, navDom: navDom }
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

check('apply() registers the settings-nav glyph effect after the styles effect', () => {
  assert(main, 'module did not load')
  const labels = main.log.effects.map((effect) => effect.label)
  const glyphEffects = main.log.effects.filter((effect) => String(effect.label).indexOf('settings-nav glyph') >= 0)
  assert(glyphEffects.length === 1, 'expected exactly one settings-nav glyph effect, got ' + glyphEffects.length)
  assert(typeof glyphEffects[0].disposer === 'function', 'the settings-nav glyph effect returned no disposer')
  const stylesAt = labels.indexOf(PLUGIN_ID + ': styles')
  const glyphAt = labels.indexOf(glyphEffects[0].label)
  assert(stylesAt >= 0, 'the styles effect is missing')
  assert(stylesAt < glyphAt, 'the glyph effect must be registered after the styles effect: ' + labels.join(' | '))
  return glyphEffects[0].label
})

check('the nav glyph decorator touches no DOM without MutationObserver', () => {
  assert(main, 'module did not load')
  const query = main.log.dom.filter((call) => call[0] === 'querySelector')
  assert(query.length > 0, 'the stylesheet guard never queried the document')
  assert(
    query[0][1].indexOf('data-plugin-css') >= 0,
    'the first DOM query is no longer the style dedupe selector: ' + String(query[0][1]),
  )
  const panelQueries = main.log.dom.filter(
    (call) => call[0] === 'querySelector' && String(call[1]).indexOf('data-shortcut-modal') >= 0,
  )
  assert(panelQueries.length === 0, 'the decorator queried the settings panel without MutationObserver')
  const glyphEffects = main.log.effects.filter((effect) => String(effect.label).indexOf('settings-nav glyph') >= 0)
  assert(glyphEffects.length === 1, 'the settings-nav glyph effect is missing')
  const before = main.log.dom.length
  glyphEffects[0].disposer()
  assert(main.log.dom.length === before, 'the glyph disposer touched the DOM without MutationObserver')
  return 'first selector = style dedupe; 0 panel queries; disposer is a no-op'
})

check("decorates only this plugin's nav row, and the disposer restores it", () => {
  const own = 'MCP 服务器'
  const decoy = '通用设置'
  const run = runSandbox({ navDom: true, navLabels: [own, decoy] })
  run.exported.apply(run.ctx)
  const bag = run.locale.dictionaries.get('mcpManager')
  assert(bag && bag.zh && bag.zh.nav === own, 'the stub label drifted from the plugin dictionary: ' + String(bag && bag.zh && bag.zh.nav))

  const dom = run.navDom
  const attr = 'data-' + PLUGIN_ID + '-nav-glyph'
  const row = dom.mine.button
  const gear = dom.mine.gear

  assert(row.children.length === 3, 'expected [glyph, gear, label] in the decorated row, got ' + row.children.length)
  const glyph = row.children[0]
  assert(glyph.tagName === 'SVG' && glyph.hasAttribute(attr), 'the first child is not the inserted marker svg')
  assert(row.children[1] === gear, 'the shipped gear is no longer the second child')
  assert(row.children[2] === dom.mine.label, 'the nav label is no longer the third child')
  assert(row.querySelectorAll('svg[' + attr + ']').length === 1, 'expected exactly one glyph svg in the row')
  assert(glyph.parentNode === row, 'the glyph is not attached to the row')
  assert(glyph.getAttribute('viewBox') === '0 0 16 16', 'viewBox mismatch: ' + String(glyph.getAttribute('viewBox')))
  assert(glyph.getAttribute('stroke-width') === '1.3', 'stroke-width mismatch: ' + String(glyph.getAttribute('stroke-width')))
  assert(glyph.getAttribute('width') === '16' && glyph.getAttribute('height') === '16', 'the glyph is not 16x16')
  assert(glyph.getAttribute('class') === 'navIcon', 'the glyph did not inherit the gear class: ' + String(glyph.getAttribute('class')))
  const NAV_GLYPH_CHILDREN = 6
  assert(glyph.children.length === NAV_GLYPH_CHILDREN, 'glyph child count mismatch: ' + glyph.children.length)
  assert(gear.style.display === 'none', 'the shipped gear was not hidden: ' + String(gear.style.display))
  assert(row.getAttribute(attr) === '1', 'the decorated row was not marked')

  const decoyRow = dom.decoy.button
  assert(decoyRow.children.length === 2, 'the decoy row was modified: ' + decoyRow.children.length + ' children')
  assert(decoyRow.children[0] === dom.decoy.gear, 'the decoy gear moved')
  assert(decoyRow.children[0].style.display !== 'none', 'the decoy gear was hidden')
  assert(decoyRow.getAttribute(attr) === null, 'the decoy row was marked')
  assert(decoyRow.querySelectorAll('svg[' + attr + ']').length === 0, 'a glyph was inserted into the decoy row')

  assert(dom.observers.length === 1, 'expected exactly one MutationObserver, got ' + dom.observers.length)
  const observer = dom.observers[0]
  assert(observer.target === dom.body, 'the observer does not watch document.body')
  assert(observer.options && observer.options.childList === true && observer.options.subtree === true, 'observer options mismatch')

  const glyphEffects = run.log.effects.filter((effect) => String(effect.label).indexOf('settings-nav glyph') >= 0)
  assert(glyphEffects.length === 1 && typeof glyphEffects[0].disposer === 'function', 'no disposer was registered for the glyph effect')
  glyphEffects[0].disposer()

  assert(observer.disconnected === true, 'the observer was not disconnected')
  assert(row.children.length === 2, 'the glyph was not removed from the row: ' + row.children.length)
  assert(glyph.parentNode === null, 'the removed glyph still has a parent')
  assert(row.children[0] === gear, 'the first child is not the shipped gear again')
  assert(gear.style.display === '', 'the gear display was not restored: ' + String(gear.style.display))
  assert(row.getAttribute(attr) === null, 'the row marker survived the disposer')
  return 'decorated 1 of 2 rows, decoy untouched, disposer restored the row'
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
