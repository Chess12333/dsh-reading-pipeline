import { loadCfg } from './config.mjs'
// page-text.mjs —— 用一个真实的 Edge（我自己的 profile）打开页面，把正文抽成纯文本。
//
// 为什么有这个（2026-11-02 06:1x，溟）：
//   今天想看知乎的回答，`web_fetch` 拿到的是空壳（www.zhihu.com 给未登录访客回 403 + 一页壳），
//   回答 API `/api/v4/questions/<id>/answers` 直接回 40362「请求存在异常」；
//   贴吧 f?kw= 回 403「百度安全验证」；微博 m.weibo.cn 直接 302 到 visitor.passport 要登录。
//   opencli 这台机器上没装。于是按 web-tools-guide 的最后一档：真浏览器。
//   不做登录动作——只读公开页，拿不到就是拿不到，不猜。
//
// 复用 `my-browser.mjs` 那套：C:\dsh\edge-ming 这个 profile + 9222 调试口。
// 它没开就自己拉起来（不带 B站 cookie，纯浏览用）。
//
// 用法：
//   node scripts/page-text.mjs <url> [--wait=4000] [--max=8000] [--json]
//     --wait  导航后等多久再抽（默认 4000ms，知乎那种要渲染）
//     --max   最多打印多少字（默认 8000）
//     --json  连 title/url/字数一起打
//     --links=N   正文之外再打 N 条页面链接（列表页看得见标题点不进去时用）
//     --links-external  只打跟当前页不同主机的链接（抓搜索结果必带，否则前十几条全是搜索站自己的导航）
//     --scroll=N  导航后往下推 N 屏再抽（懒加载页面用，默认 2）
//
// 退出码：0 = 拿到正文；2 = 页面开了但正文是空的（多半要登录或被挡）；1 = 连不上调试口。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'

const __CFG = loadCfg()
const BROWSER = __CFG.browser || {}
const EDGE = process.env.BROWSER_EXE || BROWSER.exe || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = process.env.BROWSER_PROFILE || BROWSER.profile || './.browser-profile'
const PORT = Number(process.env.BROWSER_PORT || BROWSER.port || 9222)
const WS_MOD = process.env.WS_MODULE || BROWSER.wsModule || 'ws'

/**
 * 拿一个 WebSocket：先试 `ws` 包，装不上就退回 Node 自带的（Node ≥ 22 有全局 WebSocket）。
 *
 * 2026-11-07 修：原来这里只有一条路——`await import('ws')`，装不上直接抛，而 README
 * 的配置表却写着「留空就用自带的」，两处矛盾（被浔抓到）。现在两条路都通，
 * 差别只在接口：`ws` 有 `.on()`，自带的只有 `addEventListener`，所以退回去时包一层。
 * 文档按这一版写，不留第二种说法。
 */
async function openWs(url) {
  try {
    const mod = await import(WS_MOD)
    const WS = mod.default?.WebSocket || mod.default || mod.WebSocket
    if (typeof WS === 'function') return new WS(url)
  } catch (e) {
    if (typeof globalThis.WebSocket !== 'function') {
      console.error(`没有可用的 WebSocket：ws 包加载失败（${e.message}），Node 也没有全局 WebSocket（要 ≥ 22）`)
      console.error('装一个就行：npm i ws')
      process.exit(1)
    }
    const nat = new globalThis.WebSocket(url)
    return {
      send: (d) => nat.send(d),
      close: () => nat.close(),
      on: (ev, cb) => {
        if (ev === 'message') nat.addEventListener('message', (e) => cb(e.data))
        else nat.addEventListener(ev, cb)
      },
    }
  }
  console.error(`WebSocket 模块不对：${WS_MOD} 里找不到构造函数`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const url = argv.find((a) => !a.startsWith('--'))
if (!url) { console.error('用法：node scripts/page-text.mjs <url> [--wait=4000] [--max=8000] [--json]'); process.exit(1) }
const num = (name, def) => {
  const f = argv.find((a) => a.startsWith('--' + name + '='))
  const v = f ? Number(f.split('=')[1]) : NaN
  return Number.isFinite(v) ? v : def
}
const WAIT = num('wait', 4000)
const MAX = num('max', 8000)
const asJson = argv.includes('--json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function portUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    return r.ok
  } catch { return false }
}

async function ensureBrowser() {
  if (await portUp()) return true
  mkdirSync(PROFILE, { recursive: true })
  const child = spawn(EDGE, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (await portUp()) return true
  }
  return false
}

// 起不来说明不了原因是最难受的（2026-11-07 实测：profile 里留着上次的锁，Edge 直接退出，
// 屏幕上只有一句「调试口起不来」）。这里把能查的都摆出来。
function explainBrowserFailure() {
  console.error(`调试口起不来（127.0.0.1:${PORT}）`)
  if (!existsSync(EDGE)) console.error(`  · 浏览器不存在：${EDGE}（改 browser.exe / BROWSER_EXE）`)
  const lock = path.join(PROFILE, 'SingletonLock')
  const devnull = path.join(PROFILE, 'DevToolsActivePort')
  if (existsSync(lock)) console.error(`  · profile 里有锁：${lock} —— 上次的 Edge 可能没退干净；关掉它，或换一个 browser.profile`)
  if (existsSync(devnull)) console.error(`  · 上一次的 DevToolsActivePort 还在：${devnull}（端口可能被占，换 browser.port）`)
  console.error(`  · profile：${PROFILE}`)
  console.error('  · 手动试一条：' + JSON.stringify(EDGE) + ` --user-data-dir=${JSON.stringify(PROFILE)} --remote-debugging-port=${PORT} about:blank`)
}

async function main() {
  if (!(await ensureBrowser())) { explainBrowserFailure(); process.exit(1) }

  // 新开一个标签页（新版 Chrome/Edge 要求 PUT）
  let target = null
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    target = await r.json()
  } catch { target = null }
  if (!target?.webSocketDebuggerUrl) {
    console.error('开不了新标签页（/json/new 失败）')
    process.exit(1)
  }

  const ws = await openWs(target.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(String(buf))
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    } catch { /* ignore */ }
  })

  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(WAIT)

  // 很多站（知乎、贴吧）正文是懒加载的：不滚就不渲染，innerText 里只剩标题和作者名。
  // 默认往下推两屏，再用 --scroll=N 调。
  const SCROLL = num('scroll', 2)
  for (let i = 0; i < SCROLL; i++) {
    await send('Runtime.evaluate', { expression: 'window.scrollBy(0, Math.round(innerHeight*1.5))' })
    await sleep(1200)
  }
  await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' })
  await sleep(400)

  const ev = await send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.title || '';
      const b = document.body ? document.body.innerText : '';
      // 2026-11-02 加：只给正文，想点进去时拿不到帖子链接（贴吧/知乎的列表页正是这种）。
      const links = [...document.querySelectorAll('a[href]')].map((a) => ({
        t: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        h: a.href,
      })).filter((x) => x.t && x.t.length >= 4);
      return JSON.stringify({ title: t, url: location.href, text: b, links });
    })()`,
    returnByValue: true,
  })
  const raw = ev?.result?.result?.value
  ws.close()
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`) } catch { /* ignore */ }

  if (!raw) { console.error('抽不出正文（evaluate 没回来）'); process.exit(2) }
  const page = JSON.parse(raw)
  const text = String(page.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) {
    console.error('正文是空的：' + page.url + '（多半要登录或被挡）')
    process.exit(2)
  }
  // 2026-11-02 加：--links=N 顺手把页面里的链接打出来。只给正文时，
  // 贴吧/知乎这种列表页看得见标题却点不进去（列表是懒渲染的 a[href]）。
  const LINKS = num('links', 0)
  // 2026-11-06 20:5x 加：--links-external 只留跟当前页不同主机的链接。
  // 起因：拿 --links 抓 Bing 搜索结果，前 11 条全是 bing 自己的导航/筛选链接，
  // 真正的结果链接被 slice 挤没了（搜索页的结果链接恰好都指向别的站）。
  // 注意过滤必须排在 slice 之前，否则还是先被噪声吃满。
  const LINKS_EXT = argv.includes('--links-external')
  if (LINKS > 0) {
    const hostOf = (u) => { try { return new URL(u).host } catch { return '' } }
    const pageHost = hostOf(page.url)
    const seen = new Set()
    const rows = (page.links || []).filter((l) => {
      if (seen.has(l.h)) return false
      seen.add(l.h)
      if (/^javascript:/i.test(l.h)) return false
      if (LINKS_EXT && hostOf(l.h) === pageHost) return false
      return true
    }).slice(0, LINKS)
    console.log('')
    console.log('--- 链接（' + rows.length + '）---')
    for (const l of rows) console.log(l.t + '  ' + l.h)
  }
  if (asJson) {
    console.log(JSON.stringify({ title: page.title, url: page.url, chars: text.length, text: text.slice(0, MAX) }, null, 2))
  } else {
    console.log('# ' + page.title + '  (' + page.url + ', ' + text.length + ' 字)')
    console.log(text.slice(0, MAX))
    if (text.length > MAX) console.log('\n…（截到 ' + MAX + ' 字，共 ' + text.length + '）')
  }
}

main().catch((e) => { console.error('出错：' + (e?.message ?? e)); process.exit(1) })
