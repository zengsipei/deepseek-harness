/**
 * shim-contract.test.mjs — #15 决议要求的 shim 契约测试雏形。
 * 钉住 0.1.0-rc.7 的 wrapper 形状：升级 rc 时先跑本文件，全绿才允许换钉。
 *
 * 断言的契约面（上游任何一条变化都会静默炸 TUI，这里让它显式炸）：
 *   C1  每个 client bundle import 后恰好调用一次 window.__ModuleLoader__.load({ id, factory })
 *   C2  id === 包名（注册键 = require 键）
 *   C3  factory 是 (require) => exports 的同步函数
 *   C4  externals 封闭集：factory 只 require 已知词表（platform 词 + 跨 bundle 的 `<pkg>/client`）
 *   C5  cordis 插件面形状：exports.apply 是函数、exports.inject 与钉版时一致
 *
 * 运行：node --test shim-contract.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installShim, seed, materialize, requireTrace } from './shim.mjs'

installShim()
globalThis.location = { origin: 'http://127.0.0.1:0', hostname: '127.0.0.1', search: '' }

seed.set('react', await import('react'))
seed.set('react/jsx-runtime', await import('react/jsx-runtime'))
seed.set('@deepseek-ai/cordis', await import('@deepseek-ai/cordis'))
seed.set('@deepseek-ai/dsh-client-ui-slots', await import('@deepseek-ai/dsh-client-ui-slots'))

/** 钉版事实表（0.1.0-rc.7 实测）：包名 → { inject, externals } */
const PINNED = {
  '@deepseek-ai/dsh-client-modules': { inject: undefined, externals: [] },
  '@deepseek-ai/dsh-typert-registry': { inject: [], externals: ['@deepseek-ai/cordis'] },
  '@deepseek-ai/dsh-client-connection': { inject: [], externals: [] },
  '@deepseek-ai/dsh-api-gateway': { inject: ['typert', 'connection'], externals: ['@deepseek-ai/cordis'] },
  '@deepseek-ai/dsh-api-remotes': { inject: ['remote'], externals: [] },
  '@deepseek-ai/dsh-client-runtime': {
    inject: ['connection', 'typert', 'remote', 'remote.commands'],
    externals: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots'],
  },
}

for (const [id, expected] of Object.entries(PINNED)) {
  test(`shim contract: ${id}`, async () => {
    const exports = await materialize(id) // C1/C2/C3：materialize 内部已断言 load 恰好登记该 id
    assert.equal(typeof exports, 'object', 'factory returns an exports object')
    if (expected.inject === undefined) {
      assert.equal(exports.inject, undefined, 'inject stays absent')
    } else {
      assert.deepEqual(exports.inject, expected.inject, 'C5: cordis inject list unchanged')
      assert.equal(typeof exports.apply === 'function' || typeof exports.default === 'function', true, 'C5: plugin face callable')
    }
    assert.deepEqual([...requireTrace.get(id)].sort(), [...expected.externals].sort(), 'C4: externals closed set unchanged')
  })
}
