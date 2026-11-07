// to-txt.mjs —— 把一本电子书转成 readbook 能吃的 txt
//
// 只处理手上已有的文件，不联网。
//   .txt  → 探编码，统一转成 UTF-8
//   .epub → 解压，按 spine 顺序拼 html，剥标签
//   .pdf  → 先试纯文本层；抽不出字就直说抽不出（不做 OCR）
//   .mobi → 不处理，直说
//
// 用法：
//   reading-pipeline convert <文件> [--out=目录]
//   node src/to-txt.mjs <文件> [--out=目录]
//
// 规矩跟外面那套一样：看不懂就直说，不假装成功。
// 退出码：0 成功 / 1 转不了（会说明为什么）/ 2 用法不对
//
// 2026-11-07 从「读书工具-20261107.zip」并进来（作者署名：工程师安菲）。
// 并入时改两处：解压临时目录改用 fs.rmSync 清（原来调 `cmd /c rmdir`，只有 Windows 能用）；
// 其余原样保留——epub 走 spine 顺序、pdf 只试文本层、mobi 直说不处理，这三条都算克制。

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const args = process.argv.slice(2)
const src = args.find((a) => !a.startsWith('--'))
const outDir = (args.find((a) => a.startsWith('--out=')) || '').slice(6) || path.dirname(src)
if (!src) {
  console.error('用法: node to-txt.mjs <文件> [--out=目录]')
  process.exit(2)
}
if (!existsSync(src)) {
  console.error('文件不存在：' + src)
  process.exit(1)
}

const ext = path.extname(src).toLowerCase()
const base = path.basename(src, ext)

/** 猜编码并解出字符串 */
function decode(buf) {
  // 有 BOM 就照 BOM 来
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), enc: 'utf8(bom)' }
  }
  // 先按 UTF-8 解一遍，能解回去就是 UTF-8
  const u = buf.toString('utf8')
  if (!u.includes('\ufffd')) return { text: u, enc: 'utf8' }
  // 否则按 GB18030（GBK 的超集）
  try {
    return { text: new TextDecoder('gb18030').decode(buf), enc: 'gb18030' }
  } catch {
    return { text: u, enc: 'utf8(带乱码)' }
  }
}

/** html → 纯文本：只留正文那一层 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 朴素 zip 解包：只读中央目录 + inflateRaw。epub 就是 zip，不需要外部命令。
 *  2026-11-07 换掉原来的 `tar -xf`：这台机器 PATH 里的 tar 是 GNU tar，解不了 zip，
 *  换个环境就更说不准。自己解，零依赖，也不受 PATH 影响。 */
function unzipTo(file, dir) {
  const buf = readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到中央目录）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录坏了')
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    off += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (name.split('/').includes('..')) throw new Error('压缩包里有越界路径：' + name)
    const lnameLen = buf.readUInt16LE(localOff + 26)
    const lextraLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lnameLen + lextraLen
    const raw = buf.subarray(start, start + csize)
    const out = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)
    const target = path.join(dir, ...name.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, out)
  }
}

/** epub：zip 里找 spine 顺序的 html，拼起来 */
function epubToText(file) {
  // 不引外部库。epub 是 zip，用系统自带的解压能力读出中央目录太重，
  // 这里走一个朴素办法：把 zip 全解到临时目录，再按 container.xml 找。
  const tmp = path.join(outDir, '.tmp-epub-' + Date.now())
  mkdirSync(tmp, { recursive: true })
  try {
    // 自己解 zip（不靠系统 tar）；解不开就明说，不假装成功
    unzipTo(file, tmp)
    const container = path.join(tmp, 'META-INF', 'container.xml')
    if (!existsSync(container)) throw new Error('不是标准 epub：缺 META-INF/container.xml')
    const c = readFileSync(container, 'utf8')
    const opfPath = (c.match(/full-path="([^"]+)"/i) || [])[1]
    if (!opfPath) throw new Error('container.xml 里找不到 opf 路径')
    const opf = path.join(tmp, opfPath.replace(/\//g, path.sep))
    if (!existsSync(opf)) throw new Error('opf 文件不存在：' + opfPath)
    const opfText = readFileSync(opf, 'utf8')
    const opfDir = path.dirname(opf)
    // 找 spine 里的 idref 顺序
    const idOrder = [...opfText.matchAll(/<itemref[^>]*idref="([^"]+)"/gi)].map((m) => m[1])
    // 找 manifest 里 id → href
    const hrefOf = {}
    for (const m of opfText.matchAll(/<item\b[^>]*>/gi)) {
      const tag = m[0]
      const id = (tag.match(/\bid="([^"]+)"/) || [])[1]
      const href = (tag.match(/\bhref="([^"]+)"/) || [])[1]
      const mt = (tag.match(/\bmedia-type="([^"]+)"/) || [])[1] || ''
      if (id && href && /html/i.test(mt)) hrefOf[id] = href
    }
    const parts = []
    for (const id of idOrder) {
      const href = hrefOf[id]
      if (!href) continue
      const p = path.join(opfDir, decodeURIComponent(href).replace(/\//g, path.sep))
      if (!existsSync(p)) continue
      const html = decode(readFileSync(p)).text
      const t = htmlToText(html)
      if (t) parts.push(t)
    }
    if (!parts.length) throw new Error('epub 里没找到正文 html')
    return parts.join('\n\n')
  } finally {
    // 临时目录不清也行，但留着会越堆越多；删掉
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 删不掉就留着 */ }
  }
}

/** pdf：先试文本层。抽不出字就明说 */
function pdfToText(file) {
  const buf = readFileSync(file)
  const raw = buf.toString('latin1')
  // 极简：抓所有 () Tj / TJ 里的字面量。只对未压缩的文本流有效。
  // 真实的 pdf 多半是 FlateDecode 压过的，要解压后再抓。
  const chunks = []
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body = m[1]
    let out = ''
    try {
      out = zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1')
    } catch {
      out = body // 没压缩，原样
    }
    chunks.push(out)
  }
  const all = chunks.join('\n')
  // Tj 的字面量
  const pieces = []
  for (const m of all.matchAll(/\((?:\\.|[^\\()])*\)\s*T[jJ]/g)) {
    let s = m[0].replace(/\s*T[jJ]$/, '').slice(1, -1)
    s = s.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c] ?? c))
      .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    pieces.push(s)
  }
  const text = pieces.join('').replace(/\s{3,}/g, ' ').trim()
  if (text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length < 50) {
    throw new Error('抽不出正文（多半是扫描件或用了内嵌字体编码）——这个脚本不做 OCR')
  }
  return text
}

function main() {
  mkdirSync(outDir, { recursive: true })
  let text = ''
  let how = ''

  if (ext === '.txt') {
    const { text: t, enc } = decode(readFileSync(src))
    text = t.replace(/\r\n?/g, '\n')
    how = `txt（编码 ${enc}）`
  } else if (ext === '.epub') {
    text = epubToText(src)
    how = 'epub'
  } else if (ext === '.pdf') {
    text = pdfToText(src)
    how = 'pdf（文本层）'
  } else if (ext === '.mobi') {
    throw new Error('mobi 这种格式这个脚本不处理，得先转成 epub 或 txt')
  } else {
    throw new Error('不认识的格式：' + (ext || '（没有扩展名）'))
  }

  if (!text.trim()) throw new Error('转出来是空的')

  const dst = path.join(outDir, base + '.txt')
  writeFileSync(dst, text, 'utf8')
  const chars = text.replace(/\s/g, '').length
  console.log(`OK ${dst}`)
  console.log(`  来源：${how} · ${chars} 字（不含空白）`)
  // 顺便报一下章标记认到几个——readbook 靠它切章
  const n = (text.match(/^第\s*[0-9０-９一二三四五六七八九十百千零两]+\s*[章回节]/gm) || []).length
  console.log(`  认到章标记 ${n} 个` + (n === 0 ? '（readbook 切不开，得先看看正文长什么样）' : ''))
}

try {
  main()
} catch (e) {
  console.error('转不了：' + (e?.message ?? e))
  process.exit(1)
}
