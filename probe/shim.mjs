/**
 * shim.mjs — the `window.__ModuleLoader__` shim under probe (#18).
 * Installs the loader sink, materializes pinned client bundles in graph
 * order, and records every external word each factory requires.
 */

import { registerHooks } from 'node:module'

// CSS imports inside seed packages (katex via ui-primitives) resolve to an empty module.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
    return nextLoad(url, context)
  },
})

/** seed table: specifier -> module namespace (the probe-owned platform table). */
export const seed = new Map()
/** materialized bundle exports by id. */
export const materialized = new Map()
/** per-bundle require trace: id -> Set of specifiers pulled from seed/materialized. */
export const requireTrace = new Map()
/** specifiers requested but absent everywhere (hard misses). */
export const misses = []

const pending = new Map() // id -> factory, staged by load()

export function installShim() {
  if (globalThis.window === undefined) globalThis.window = globalThis
  if (globalThis.window.__ModuleLoader__ !== undefined) return
  globalThis.window.__ModuleLoader__ = {
    load({ id, factory }) {
      pending.set(id, factory)
    },
  }
}

function makeRequire(forId) {
  const trace = new Set()
  requireTrace.set(forId, trace)
  return (spec) => {
    trace.add(spec)
    if (seed.has(spec)) return seed.get(spec)
    if (materialized.has(spec)) return materialized.get(spec)
    // Cross-bundle references are emitted as `<pkg>/client`; alias to the materialized id.
    const bare = spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : undefined
    if (bare !== undefined && materialized.has(bare)) return materialized.get(bare)
    if (bare !== undefined && seed.has(bare)) return seed.get(bare)
    misses.push({ bundle: forId, spec })
    throw new Error(`shim require miss: "${spec}" (while materializing ${forId})`)
  }
}

/**
 * Import one package's client bundle and run its staged factory.
 * @param {string} id - package name (= registration id = future require key).
 * @returns the bundle's exports (also seeded for later bundles).
 */
export async function materialize(id) {
  await import(`${id}/client`)
  const factory = pending.get(id)
  if (factory === undefined) throw new Error(`bundle ${id} imported but never called __ModuleLoader__.load`)
  const exports = factory(makeRequire(id))
  materialized.set(id, exports)
  return exports
}
