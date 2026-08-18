/**
 * mock-llm.mjs — minimal OpenAI-compatible /v1/chat/completions SSE upstream
 * for the #18 probe. Scripted: a turn whose transcript already carries a tool
 * result answers with plain text; otherwise, if the request declares a shell
 * tool, answer one tool_call to trigger the approval path; else plain text.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_LLM_PORT ?? 9410)

async function sseChunks(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const c of chunks) {
    res.write(`data: ${JSON.stringify(c)}\n\n`)
    await new Promise(r => setTimeout(r, 120))
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

const base = { id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: 'probe-model' }
const delta = (d, finish = null) => ({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] })

createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404); res.end(); return
  }
  let body = ''
  req.on('data', (b) => { body += b })
  req.on('end', () => {
    const payload = JSON.parse(body)
    const messages = payload.messages ?? []
    const hasToolResult = messages.some(m => m.role === 'tool')
    const shellTool = (payload.tools ?? []).map(t => t.function?.name).find(n => /pwsh|bash|shell/i.test(n ?? ''))
    const wantsTool = messages.some(m => m.role === 'user' && String(m.content).includes('PROBE_RUN_TOOL'))
    console.log(`[mock-llm] turn: messages=${messages.length} hasToolResult=${hasToolResult} shellTool=${shellTool} wantsTool=${wantsTool}`)
    if (hasToolResult) {
      sseChunks(res, [
        delta({ role: 'assistant', content: '' }),
        delta({ content: 'tool finished; probe turn 2 complete.' }),
        delta({}, 'stop'),
      ])
    } else if (wantsTool && shellTool !== undefined) {
      sseChunks(res, [
        delta({ role: 'assistant', content: '' }),
        delta({ tool_calls: [{ index: 0, id: 'call_probe_1', type: 'function', function: { name: shellTool, arguments: '' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'echo probe-approved', description: 'probe escalation test', sandbox_permissions: 'danger-full-access', justification: 'probe: force the approval round trip' }) } }] }),
        delta({}, 'tool_calls'),
      ])
    } else {
      sseChunks(res, [
        delta({ role: 'assistant', content: '' }),
        delta({ content: 'hello from ' }),
        delta({ content: 'the mock upstream.' }),
        delta({}, 'stop'),
      ])
    }
  })
}).listen(PORT, '127.0.0.1', () => console.log(`[mock-llm] listening on 127.0.0.1:${PORT}`))
