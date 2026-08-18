/** stage1.mjs — load-only probe: materialize the six bundles in graph order, report externals. */
import { installShim, seed, materialize, requireTrace, misses } from './shim.mjs'

installShim()
// probe-owned location shim: answers resolveBase(), the ?fixture check, and isLoopback in one move.
globalThis.location = { origin: 'http://127.0.0.1:3210', hostname: '127.0.0.1', search: '' }

seed.set('react', await import('react'))
seed.set('react/jsx-runtime', await import('react/jsx-runtime'))
seed.set('@deepseek-ai/cordis', await import('@deepseek-ai/cordis'))
seed.set('@deepseek-ai/dsh-client-ui-slots', await import('@deepseek-ai/dsh-client-ui-slots'))

const order = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-runtime',
]

for (const id of order) {
  try {
    const exports = await materialize(id)
    console.log(`OK   ${id}  exports=${Object.keys(exports).length}  requires=[${[...requireTrace.get(id)].join(', ')}]`)
  } catch (error) {
    console.log(`FAIL ${id}: ${error.message}`)
  }
}
if (misses.length > 0) console.log('misses:', misses)
