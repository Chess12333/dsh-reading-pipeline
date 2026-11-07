#!/usr/bin/env node
/**
 * embed-local.mjs —— **内置的退化嵌入服务**（零依赖）
 *
 * 为什么有它：原来 doc-emb 必须先在本机起一个 OpenAI 兼容的嵌入服务
 * （127.0.0.1:18081，bge-base-zh-v1.5），不起的话第四步直接走不通。
 * 一个"装上就能用"的包不该卡在这儿，所以这里提供一个**兜底**：
 * 起一个同接口的小服务器（`/v1/embeddings`），不换任何下游代码。
 *
 * 代价说清楚：它做的是**字符 n-gram 哈希 + L2 归一**，不是语义模型。
 *   · 词面相近 → 分数高（同义、近义、换说法基本不灵）
 *   · 好处是零依赖、零下载、离线能跑，中文不切词也能用
 *   · 真要按意思搜，还是配远端模型（`embed.endpoint` / `EMB_ENDPOINT`）
 * 所以它是**兜底**，不是替代。索引里会记下用的是哪种模式（mode），
 * 混用会让分数看起来对、实际错位，遇到不一致就要求重建。
 *
 * 单独用（想把索引建在别的进程里）：
 *   node src/embed-local.mjs --port=18081 --dim=768
 */

import http from 'node:http'

const DEFAULT_DIM = 768

// ── 分词：中文按字 + 字二元组，西文按词 ───────────────────────────
function tokens(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  // 西文词
  for (const w of s.match(/[a-z0-9_]+/g) || []) out.push('w:' + w)
  // 中文：单字 + 二元组（不分词也够用，代价是只认字面）
  const han = s.match(/[\u4e00-\u9fff]+/g) || []
  for (const run of han) {
    for (let i = 0; i < run.length; i++) {
      out.push('c:' + run[i])
      if (i + 1 < run.length) out.push('b:' + run.slice(i, i + 2))
    }
  }
  return out
}

// FNV-1a 32 位，确定性；同一句话在任何机器上落到同样的桶
function hash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function localEmbed(text, dim = DEFAULT_DIM) {
  const v = new Float32Array(dim)
  const toks = tokens(text)
  for (const t of toks) {
    const h = hash(t)
    const idx = h % dim
    // 符号位也由哈希决定：减少大量哈希挤在同一桶时的系统性偏置
    const sign = (h & 0x80000000) ? -1 : 1
    v[idx] += sign
  }
  let n = 0
  for (let i = 0; i < dim; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < dim; i++) v[i] /= n
  return Array.from(v)
}

/** 探一下某个端点通不通（不抛错，只回 true/false + 原因） */
export async function probeEndpoint(endpoint, timeoutMs = 1500) {
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: ['ping'], model: 'probe' }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` }
    const j = await r.json()
    if (!j?.data?.[0]?.embedding) return { ok: false, why: '响应里没有 embedding' }
    return { ok: true, dim: j.data[0].embedding.length }
  } catch (e) {
    return { ok: false, why: e.name === 'TimeoutError' ? '超时' : e.message }
  }
}

/** 起一个 OpenAI 兼容的 /v1/embeddings；回 { url, close } */
export function startLocalEmbedServer({ port = 0, dim = DEFAULT_DIM } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const send = (code, obj) => {
        const body = JSON.stringify(obj)
        res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        res.end(body)
      }
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
        return send(200, { ok: true, mode: 'local-hash', dim })
      }
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/embeddings')) return send(404, { error: 'not found' })

      let raw = ''
      req.on('data', (c) => { raw += c; if (raw.length > 32 * 1024 * 1024) req.destroy() })
      req.on('end', () => {
        let payload
        try { payload = JSON.parse(raw) } catch { return send(400, { error: 'bad json' }) }
        const input = Array.isArray(payload?.input) ? payload.input : [payload?.input ?? '']
        const data = input.map((t, i) => ({ object: 'embedding', index: i, embedding: localEmbed(t, dim) }))
        send(200, { object: 'list', model: payload?.model || 'local-hash', data })
      })
    })
    // 用完不让它拖住事件循环：build 完就该退出，不能因为留着一个监听句柄挂在这儿
    server.unref()
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port
      resolve({
        url: `http://127.0.0.1:${p}/v1/embeddings`,
        dim,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// ── 直接跑：当独立服务用 ─────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d
  const port = Number(arg('port', 18081))
  const dim = Number(arg('dim', DEFAULT_DIM))
  const { url } = await startLocalEmbedServer({ port, dim })
  console.log(`内置嵌入服务已起：${url}（dim=${dim}，字符 n-gram 哈希，非语义模型）`)
  console.log('Ctrl+C 结束。想换真模型就把 embed.endpoint 指到那个服务上。')
}
