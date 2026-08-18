/**
 * stage2.mjs — full-chain probe (#18): mount the client graph in a Node
 * cordis Context over the shim, connect to the real host on 127.0.0.1:3210,
 * and drive the three product round trips.
 */
import { installShim, seed, materialize, misses } from './shim.mjs'

installShim()
globalThis.location = { origin: 'http://127.0.0.1:3210', hostname: '127.0.0.1', search: '' }

seed.set('react', await import('react'))
seed.set('react/jsx-runtime', await import('react/jsx-runtime'))
const cordis = await import('@deepseek-ai/cordis')
seed.set('@deepseek-ai/cordis', cordis)
seed.set('@deepseek-ai/dsh-client-ui-slots', await import('@deepseek-ai/dsh-client-ui-slots'))

const order = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-runtime',
]
const bundles = {}
for (const id of order) bundles[id] = await materialize(id)
console.log('[stage2] all bundles materialized; misses:', misses.length)

const ctx = new cordis.Context()
// Mount graph order = web-app roster order (dsh.client inject edges).
for (const id of order) {
  if (id === '@deepseek-ai/dsh-client-modules') continue // TUI 壳自建加载表：跳过 modules 行（#15 绕行）
  await ctx.plugin(bundles[id])
}

// Wait for the runtime services to arrive.
const deadline = Date.now() + 15000
while (ctx.get('sessions') === undefined) {
  if (Date.now() > deadline) throw new Error('sessions service never arrived')
  await new Promise(r => setTimeout(r, 100))
}
const sessions = ctx.get('sessions')
// Instrument: log every mux frame the runtime routes.
const origMux = sessions.handleMuxEnvelope.bind(sessions)
sessions.handleMuxEnvelope = (envelope) => {
  const p = envelope.payload
  console.log('[mux->runtime]', p.type, p.sessionId ?? '', p.type === 'session/event' ? p.event?.type : '')
  return origMux(envelope)
}
console.log('[stage2] ctx.sessions arrived. methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(sessions)).join(', '))

// ── round trip 3 (cheapest first): sessions.list ────────────────────────────
const api = ctx.get('connection').api
console.log('[stage2] api client methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(Object.getPrototypeOf(api))).join(', '))

// wait for list baseline
await new Promise(r => setTimeout(r, 1500))
const listState = sessions.list.getSnapshot()
console.log('[stage2] sessions.list state keys:', Object.keys(listState), 'phase:', listState.phase, 'rows:', (listState.sessions ?? listState.items ?? []).length)

// ── create a session and bind it ────────────────────────────────────────────
const sessionId = await sessions.create({ cwd: 'F:/zsp/Ai/dsh-shim-probe' })
console.log('[stage2] created session', sessionId)
sessions.open(sessionId)
const binding = sessions.binding !== undefined ? sessions.binding(sessionId) : undefined
console.log('[stage2] binding:', binding === undefined ? 'undefined (introspect needed)' : Object.keys(binding).join(', '))
const session = binding?.session ?? binding
if (session === undefined) throw new Error('no session face; ISessions members: ' + Object.getOwnPropertyNames(Object.getPrototypeOf(sessions)).join(','))

// ── round trip 1: prompt → token stream projection ─────────────────────────
const res1 = await session.prompt([{ type: 'text', text: 'hello probe' }], 'queue')
console.log('[stage2] prompt#1 result:', JSON.stringify(res1))

/** Defensive deep text extraction: cordis proxies throw on stray gets, so guard every step. */
function safeText(value, depth = 0, seen = new Set()) {
  if (depth > 8 || value === null || value === undefined) return ''
  const t = typeof value
  if (t === 'string') return value + '\n'
  if (t !== 'object') return ''
  if (seen.has(value)) return ''
  seen.add(value)
  let out = ''
  try {
    for (const k of Object.keys(value)) {
      if (k === 'ctx') continue
      try { out += safeText(value[k], depth + 1, seen) } catch { /* proxy trap */ }
    }
  } catch { /* proxy trap */ }
  return out
}

// Subscription-driven observation: accumulate every snapshot transition (no polling gaps).
let observed = ''
let lastSnap
const note = () => {
  lastSnap = session.getSnapshot()
  observed += safeText(lastSnap)
}
session.subscribe(note)
note()

async function waitObserved(pred, label, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (pred()) return lastSnap ?? session.getSnapshot() } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 100))
  }
  console.log(`[stage2] TIMEOUT waiting ${label}; observed text:`, observed.slice(-2000))
  throw new Error(`timeout: ${label}`)
}

async function waitSnapshot(pred, label, ms = 30000) {
  return waitObserved(() => pred(session.getSnapshot()), label, ms)
}

/** Raw-window scan: the assembler needs ui-conversation definitions (TUI brings its own),
 *  so the probe asserts at the Session store's raw event window (@internal but real). */
function rawEventText() {
  return (session.events ?? []).map(e => JSON.stringify(e)).join('\n')
}

const snap1 = await waitObserved(
  () => rawEventText().includes('mock upstream'),
  'assistant text from mock (raw session-event window)',
)
const chunkCount = (session.events ?? []).filter(e => e.type === 'assistant/chunk').length
console.log(`[stage2] ✅ round trip 1: token stream landed in the session window. rawEvents=${session.events.length} assistant/chunk=${chunkCount}`)

// ── round trip 2: approval requested → respond → resolved ──────────────────
const res2 = await session.prompt([{ type: 'text', text: 'PROBE_RUN_TOOL please' }], 'queue')
console.log('[stage2] prompt#2 result:', JSON.stringify(res2))

const snapPending = await waitSnapshot(
  s => (s.pending ?? []).length > 0,
  'approval pending',
)
const pendingList = snapPending.pending ?? []
console.log('[stage2] pending entries:', pendingList.length, pendingList.map(p => p.kind ?? p.status ?? '?').join(','))
const approval = pendingList.find(p => (p.kind ?? '') === 'approval') ?? pendingList[0]
console.log('[stage2] approval payload:', JSON.stringify(approval?.payload ?? approval, (k, v) => typeof v === 'function' ? '[fn]' : v).slice(0, 800))

const receipt = await approval.respond({
  ok: true,
  value: { sessionId, approvalId: approval.payload.approvalId, outcome: 'allowed-once' },
})
console.log('[stage2] approval respond receipt:', JSON.stringify(receipt))

const snap2 = await waitObserved(
  () => rawEventText().includes('probe turn 2 complete'),
  'post-approval final text',
  45000,
)
console.log('[stage2] ✅ round trip 2: approval resolved, tool ran, final text arrived.')

// ── round trip 3 confirm via raw list after activity ────────────────────────
const listNow = sessions.list.getSnapshot()
console.log('[stage2] ✅ round trip 3: sessions.list rows:', JSON.stringify(listNow, (k, v) => typeof v === 'function' ? undefined : v).slice(0, 600))

console.log('[stage2] ALL THREE ROUND TRIPS OK')
process.exit(0)
