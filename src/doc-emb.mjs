#!/usr/bin/env node
import { loadCfg } from './config.mjs'
/**
 * doc-emb.mjs —— 给「我的全部档案」做向量索引，供按意思检索。
 *
 * 为什么有它：semantic-search.mjs 只索引了会话块（chat-corpus），
 * diary / sightings / learned / reading / writing / day / persona 都只有 BM25。
 * 可我常记得「意思」不记得「词」，BM25 就找不到。
 *
 * 用法：
 *   node scripts\doc-emb.mjs build            # 全量重建（几分钟）
 *   node scripts\doc-emb.mjs search "…" [--k=5]
 *   node scripts\doc-emb.mjs stat
 *
 * 产物：live\doc-emb.f32（归一化向量，768 维）+ live\doc-emb-ids.json（分块元信息）
 * 依赖：本地嵌入服务 127.0.0.1:18081（bge-base-zh-v1.5）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 召唤痕迹记账依赖一个外部库；导出包里改成按需加载，对方没有这个库时自动跳过。

const __CFG = loadCfg()
const ROOT = process.env.READ_ROOT || __CFG.root || process.cwd()
const DIRS = Array.isArray(__CFG.dirs) && __CFG.dirs.length ? __CFG.dirs : [['reading', 'reading']];
const OUT_EMB = path.join(ROOT, 'live/doc-emb.f32')
const OUT_IDS = path.join(ROOT, 'live/doc-emb-ids.json')
const MANIFEST = path.join(ROOT, 'live/doc-emb-manifest.json')
let ENDPOINT = process.env.EMB_ENDPOINT || (__CFG.embed && __CFG.embed.endpoint) || 'http://127.0.0.1:18081/v1/embeddings'
const EMBED_MODE_CFG = process.env.EMB_MODE || (__CFG.embed && __CFG.embed.mode) || 'auto' // auto | remote | local
let EMBED_MODE = 'remote'

// 2026-11-07 加：远端嵌入服务不通时**自动降级**，不再让第四步直接走不通。
// 原来这里硬依赖 127.0.0.1:18081，一个人解压完跑 build 就卡死在这一步——
// 「装上就能用」不该要求先自己起一个模型服务。
// 降级用的是 src/embed-local.mjs（字符 n-gram 哈希，零依赖、离线），
// 它暴露同一个 /v1/embeddings 接口，所以下游一行都不用改。
// 代价：词面相近才搜得到，真要按意思搜还是起远端模型。索引里会记 mode，混用会被拦下。
async function ensureEmbedder() {
  const { probeEndpoint, startLocalEmbedServer } = await import('./embed-local.mjs')
  const useLocal = async (why) => {
    const s = await startLocalEmbedServer({ dim: DIM })
    ENDPOINT = s.url
    EMBED_MODE = 'local'
    console.log(`\n⚠️  远端嵌入服务用不了（${why}）→ 已在本进程起内置退化嵌入 ${s.url}（dim=${DIM}）`)
    console.log('   它能跑通全流程，但只认字面：同义词、换说法搜不到。要语义检索请起真模型并配 embed.endpoint。\n')
  }
  if (EMBED_MODE_CFG === 'local') return useLocal('embed.mode=local')
  const p = await probeEndpoint(ENDPOINT)
  if (p.ok) {
    EMBED_MODE = 'remote'
    if (p.dim && p.dim !== DIM) console.log(`⚠️  远端返回 ${p.dim} 维，配置写的是 ${DIM} 维——按配置走，不一致会写坏索引，先对齐再跑`)
    return
  }
  if (EMBED_MODE_CFG === 'remote') {
    console.error(`远端嵌入服务不通（${p.why}）：${ENDPOINT}`)
    console.error('配置里写了 embed.mode=remote，不允许降级。要么把服务起来，要么改成 auto/local。')
    process.exit(1)
  }
  return useLocal(p.why)
}
const MODEL = process.env.EMB_MODEL || (__CFG.embed && __CFG.embed.model) || 'bge-base-zh-v1.5-q8_0'
const DIM = Number((__CFG.embed && __CFG.embed.dim) || 768)
const CHARS = Number((__CFG.embed && __CFG.embed.chars) || 400)
const OVERLAP = 80
const BATCH = 16
// 2026-11-06 加：fetch 原来没有超时，服务端一旦不回，整轮 build 会静默挂死
// （02:59 那次：进程活着、13 分钟只用了 1.8 秒 CPU、日志一个字不吐）
const REQ_TIMEOUT_MS = 60_000
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

const args = process.argv.slice(2)
const cmd = args[0] || 'stat'
const num = (n, d) => {
  const hit = args.find((a) => a.startsWith('--' + n + '='))
  return hit ? Number(hit.split('=')[1]) : d
}

function listMd(dir) {
  // 2026-11-06 改：原来只列顶层，writing/小说/ 下 54 个文件一个都没进索引——
  // 也就是我写的全部小说，按意思搜是搜不到的（"我不记得" ≠ "查不到"，那次是我自己没被搜到）
  const out = []
  const walk = (d) => {
    let ents = []
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) out.push(p)
    }
  }
  walk(dir)
  return out
}

function chunks() {
  const out = []
  for (const [dir, src] of DIRS) {
    for (const f of listMd(path.join(ROOT, dir))) {
      let raw = ''
      try {
        raw = fs.readFileSync(f, 'utf8')
      } catch {
        continue
      }
      const title = path.basename(f, '.md')
    const text = raw.split(String.fromCharCode(13)).join('')
      for (let off = 0; off < text.length; off += CHARS - OVERLAP) {
        const piece = text.slice(off, off + CHARS)
        if (piece.trim().length < 40) continue
        out.push({ file: f, src, title, off, text: piece })
      }
    }
  }
  return out
}

async function postEmbed(payload) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
}

async function embedAll(list) {
  const vecs = []
  let done = 0
  const t0 = Date.now()
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH).map((c) => c.text)
    let j = null
    for (let attempt = 0; attempt < 2 && !j; attempt++) {
      try {
        const r = await postEmbed({ input: batch, model: MODEL })
        if (r.ok) j = await r.json()
        else {
          console.log(`  批次 HTTP ${r.status}，重试`)
          await new Promise((res) => setTimeout(res, 500))
        }
      } catch (e) {
        console.log(`  批次 ${e.name}: ${e.message}，重试`)
        await new Promise((res) => setTimeout(res, 500))
      }
    }
    if (!j) {
      for (const one of batch) {
        const r = await postEmbed({ input: [one.slice(0, 400)], model: MODEL })
        // 2026-11-01 改：原来这里 HTTP 失败就写一个全零向量——索引不会报错，只会静默变坏
        // （零向量跟谁都不相似，搜什么都搜不到，看起来像"没有这条"）。宁可整个 inc 失败。
        if (!r.ok) throw new Error('嵌入失败：HTTP ' + r.status + '（不写零向量，否则索引会静默坏掉）')
        const jj = await r.json()
        j = j || { data: [] }
        j.data.push(jj.data[0])
      }
    }
    done += batch.length
    if (i % (BATCH * 20) === 0 || done >= list.length) {
      const sec = (Date.now() - t0) / 1000
      console.log(`  ${done}/${list.length} 块 · ${sec.toFixed(1)}s · ${(done / Math.max(0.1, sec)).toFixed(1)} 块/秒`)
    }
    for (const d of j.data) {
      const v = new Float32Array(d.embedding)
      let n = 0
      for (let k = 0; k < v.length; k++) n += v[k] * v[k]
      n = Math.sqrt(n) || 1
      for (let k = 0; k < v.length; k++) v[k] /= n
      vecs.push(v)
    }
    process.stdout.write(`\r嵌入 ${Math.min(i + BATCH, list.length)}/${list.length}`)
  }
  process.stdout.write('\n')
  return vecs
}

// 2026-11-04 加：落盘「先写临时文件再 rename」，读取时校验条数和字节数对得上。
// 起因：看 B站 拆 OpenClaw 记忆系统（BV1C5fiBREUu），它全量重建走双库原子交换；
// 我这边原来是三个 writeFileSync 挨着写，中间断掉就是 emb 新、ids 旧——向量和正文错位，
// 搜索结果会安静地指到别的文件上。宁可不搜，也不能指错。
function saveIndex(ids, flat) {
  const tmp = (p) => p + '.tmp'
  fs.writeFileSync(tmp(OUT_EMB), Buffer.from(flat.buffer))
  fs.writeFileSync(tmp(OUT_IDS), JSON.stringify(ids))
  // 2026-11-07：把「这批向量是哪种模式算的」落进清单。远端模型和内置哈希算出来的向量
  // 不在同一个空间里，混着搜出来的分数看着正常、实际全错，所以这个字段是闸，不是备注。
  const man = manifestOf(ids.map((m) => ({ file: m.file })))
  man.embed = { mode: EMBED_MODE, dim: DIM, model: EMBED_MODE === 'local' ? 'local-hash' : MODEL, builtAt: new Date().toISOString() }
  fs.writeFileSync(tmp(MANIFEST), JSON.stringify(man))
  // rename 顺序：向量 → 编号 → 清单。清单最后落，它是这一批的落款。
  fs.renameSync(tmp(OUT_EMB), OUT_EMB)
  fs.renameSync(tmp(OUT_IDS), OUT_IDS)
  fs.renameSync(tmp(MANIFEST), MANIFEST)
}

function loadIndex() {
  const ids = JSON.parse(fs.readFileSync(OUT_IDS, 'utf8'))
  const buf = fs.readFileSync(OUT_EMB)
  const expect = ids.length * DIM * 4
  if (buf.length !== expect) {
    throw new Error(
      `索引不一致：${ids.length} 条编号 vs ${buf.length / (DIM * 4)} 条向量（向量文件应 ${expect} 字节）。` +
        '上次落盘可能被打断——先跑 node scripts\\doc-emb.mjs build 重建，别在这样的索引上搜。',
    )
  }
  return { ids, buf }
}

async function build() {
  const list = chunks()
  console.log('分块数：' + list.length)
  if (!list.length) console.log('  0 块：每块至少要 40 个字（不足的会被跳过），先确认 reading/ 里真有内容，或者 embed.chars 是不是被调得太小了')
  const vecs = await embedAll(list)
  const flat = new Float32Array(vecs.length * DIM)
  vecs.forEach((v, i) => flat.set(v, i * DIM))
  saveIndex(
    list.map((c, i) => ({ i, file: c.file, src: c.src, title: c.title, off: c.off, text: c.text })),
    flat,
  )
  console.log('落盘：' + OUT_EMB + ' / ' + OUT_IDS)
}

// 每个文件一行：mtime + 大小 + 块数，增量用
function manifestOf(list) {
  const files = {}
  for (const c of list) {
    const st = fs.statSync(c.file)
    if (!files[c.file]) files[c.file] = { mtime: st.mtimeMs, size: st.size, chunks: 0 }
    files[c.file].chunks += 1
  }
  return { builtAt: Date.now(), files }
}

async function search(q, k) {
  if (!fs.existsSync(OUT_EMB) || !fs.existsSync(OUT_IDS)) {
    console.error('还没有索引，先跑 build')
    process.exit(1)
  }
  // 闸：索引是用哪种模式建的，就得用哪种模式查。混着查分数照样出来，但全是错的。
  try {
    const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    const built = man?.embed?.mode
    if (built && built !== EMBED_MODE) {
      console.error(`这份索引是用「${built}」建的，这次查询走的是「${EMBED_MODE}」——不在同一个向量空间，分数没意义。`)
      console.error(`要么按建索引时的模式再查一次（EMB_MODE=${built}），要么重建索引（build）。`)
      process.exit(1)
    }
    if (man?.embed?.dim && Number(man.embed.dim) !== DIM) {
      console.error(`索引维度 ${man.embed.dim} 与配置 ${DIM} 不一致，先对齐再查。`)
      process.exit(1)
    }
  } catch { /* 旧索引没有这个字段，不拦 */ }
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: [QUERY_PREFIX + q], model: EMBED_MODE === 'local' ? 'local-hash' : MODEL }),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const qv = new Float32Array((await r.json()).data[0].embedding)
  let qn = 0
  for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i]
  qn = Math.sqrt(qn) || 1

  const { ids, buf } = loadIndex()
  const n = ids.length
  const scores = []
  for (let i = 0; i < n; i++) {
    let s = 0
    const base = i * DIM * 4
    for (let d = 0; d < DIM; d++) s += qv[d] * buf.readFloatLE(base + d * 4)
    scores.push([s / qn, i])
  }
  scores.sort((a, b) => b[0] - a[0])
  console.log(`「${q}」→ ${k} 条（文档向量）\n`)
  for (const [s, i] of scores.slice(0, k)) {
    const m = ids[i]
    const lines = (m.text || '').split('\n').map((x) => x.trim()).filter(Boolean)
    const peek = lines.slice(0, 3).join(' / ').slice(0, 180)
    console.log(`${s.toFixed(3)}  [${m.src}] ${path.basename(m.file)} @${m.off}`)
    console.log('   ' + peek + '\n')
  }

  // 召唤痕迹：按文件记，不按 chunk（400 字一块，同一条记忆会被切成好几块）
  try {
    const { record: recallRecord, readRows: recallRows, fold: recallFold } = await import('../../dsh-ming-core-memory/lib/recall.js')
    const seen = new Map()
    for (const [, i] of scores.slice(0, k)) {
      const f = ids[i].file
      if (!seen.has(f)) seen.set(f, 'doc:' + path.relative(ROOT, f).replace(/\\/g, '/'))
    }
    const memoryDir = path.join(os.homedir(), '.dsh', 'memory')
    const before = recallFold(await recallRows(memoryDir))
    const hits = [...seen.entries()].map(([f, key]) => ({ f, key, n: ((before.stats.get(key) || {}).n || 0) + 1 }))
    await recallRecord(memoryDir, { query: q, ids: hits.map((x) => x.key), total: n, shown: hits.length, src: 'doc' })
    console.log('召唤：' + hits.slice(0, 3).map((x) => `第${x.n}次 ${path.basename(x.f)}`).join(' · '))
  } catch { /* 记账失败不打断检索 */ }
}


// ---------- 增量 ----------
const hashChunk = (text) => {
  // 2026-11-06：块级复用用。同一段文本永远得同一个向量，所以同一块不必重嵌。
  let h = 5381
  for (let k = 0; k < text.length; k++) h = ((h * 33) ^ text.charCodeAt(k)) >>> 0
  return h.toString(36) + ':' + text.length
}

async function inc() {
  if (!fs.existsSync(MANIFEST) || !fs.existsSync(OUT_IDS) || !fs.existsSync(OUT_EMB)) {
    console.log('没有基线，先做一次全量')
    return build()
  }
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).files || {}
  const ids = JSON.parse(fs.readFileSync(OUT_IDS, 'utf8'))
  const buf = fs.readFileSync(OUT_EMB)

  const current = new Map()
  for (const [dir] of DIRS) {
    for (const f of listMd(path.join(ROOT, dir))) {
      const st = fs.statSync(f)
      current.set(f, { mtime: st.mtimeMs, size: st.size })
    }
  }

  const unchanged = new Set()
  for (const [f, st] of current) {
    const m = man[f]
    if (m && Math.abs(m.mtime - st.mtime) < 1 && m.size === st.size) unchanged.add(f)
  }

  const vecOf = (i) => {
    const v = new Float32Array(DIM)
    for (let d = 0; d < DIM; d++) v[d] = buf.readFloatLE(i * DIM * 4 + d * 4)
    return v
  }

  // 旧索引里每一块的 hash → 向量；改一个文件时，没动的块直接复用
  // （起因：每次往 reading/笔记-何氏语林.md 追加一节，整份文件 600 多块全部重嵌，约 4 分钟）
  const oldByHash = new Map()
  for (const m of ids) {
    const h = m.h || (m.text ? hashChunk(m.text) : null)
    if (!h) continue
    if (!oldByHash.has(h)) oldByHash.set(h, vecOf(m.i))
  }

  // 复用的块也要带上 text：少了它，search 的预览会 undefined.split 崩掉（2026-11-06 08:30 修的）。
  // 顺带自愈：老索引里但凡有缺 text 的块，按 off 从文件里重新切一段补回来。
  const fileTextCache = new Map()
  const sliceOf = (file, off) => {
    if (!fileTextCache.has(file)) {
      let t = ''
      try {
        t = fs.readFileSync(file, 'utf8').split(String.fromCharCode(13)).join('')
      } catch {
        t = ''
      }
      fileTextCache.set(file, t)
    }
    return fileTextCache.get(file).slice(off, off + CHARS)
  }

  let healed = 0
  const keptIds = []
  const keptVecs = []
  for (const m of ids) {
    if (!unchanged.has(m.file)) continue
    let base = m
    if (!m.text) {
      base = { ...m, text: sliceOf(m.file, m.off) }
      healed++
    }
    keptIds.push(base.h ? base : { ...base, h: hashChunk(base.text || '') })
    keptVecs.push(vecOf(m.i))
  }

  const toEmbed = []
  const reuseIds = []
  const reuseVecs = []
  let reused = 0
  for (const [f, st] of current) {
    if (unchanged.has(f)) continue
    let raw = ''
    try {
      raw = fs.readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const title = path.basename(f, '.md')
    const src = (DIRS.find(([d]) => f.startsWith(path.join(ROOT, d))) || [null, 'doc'])[1]
    const text = raw.split(String.fromCharCode(13)).join('')
    for (let off = 0; off < text.length; off += CHARS - OVERLAP) {
      const piece = text.slice(off, off + CHARS)
      if (piece.trim().length < 40) continue
      const h = hashChunk(piece)
      const v = oldByHash.get(h)
      if (v) {
        reuseIds.push({ file: f, src, title, off, text: piece, h })
        reuseVecs.push(v)
        reused++
      } else {
        toEmbed.push({ file: f, src, title, off, text: piece, h })
      }
    }
  }

  console.log('未变 ' + unchanged.size + ' 个文件 / 待嵌 ' + toEmbed.length + ' 块 / 按块复用 ' + reused + ' 块' + (healed ? ' / 补回 text ' + healed + ' 块' : ''))
  const newVecs = toEmbed.length ? await embedAll(toEmbed) : []
  const allIds = keptIds.concat(reuseIds, toEmbed).map((m, i) => ({ ...m, i }))
  const allVecs = keptVecs.concat(reuseVecs, newVecs)
  const flat = new Float32Array(allVecs.length * DIM)
  allVecs.forEach((v, i) => flat.set(v, i * DIM))
  saveIndex(allIds, flat)
  console.log('增量完成：保留 ' + keptIds.length + ' + 复用 ' + reuseIds.length + ' + 新嵌 ' + toEmbed.length + ' = ' + allIds.length + ' 块')
}

function stat() {
  if (!fs.existsSync(OUT_IDS)) {
    console.log('还没有索引')
    return
  }
  const ids = JSON.parse(fs.readFileSync(OUT_IDS, 'utf8'))
  const by = {}
  for (const m of ids) by[m.src] = (by[m.src] || 0) + 1
  console.log(`分块 ${ids.length} 个，覆盖 ${new Set(ids.map((m) => m.file)).size} 个文件`)
  for (const [k, v] of Object.entries(by)) console.log(`  ${k.padEnd(10)} ${v}`)
}

if (cmd === 'build' || cmd === 'inc' || cmd === 'search') await ensureEmbedder()
if (cmd === 'build') await build()
else if (cmd === 'inc') await inc()
else if (cmd === 'search') {
  const k = num('k', 5)
  const q = args.slice(1).filter((a) => !a.startsWith('--')).join(' ').trim()
  if (!q) {
    console.error('用法：node scripts\\doc-emb.mjs search "查什么" [--k=5]')
    process.exit(2)
  }
  await search(q, k)
} else stat()
