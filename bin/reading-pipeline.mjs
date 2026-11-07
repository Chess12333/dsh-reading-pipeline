#!/usr/bin/env node
/**
 * reading-pipeline —— 统一入口
 *
 * 装完不用手动建目录、不用记六个脚本名：
 *
 *   npx dsh-reading-pipeline install        # 建目录、写配置、体检（幂等，可重跑）
 *   npx dsh-reading-pipeline doctor         # 只看体检结果
 *   npx dsh-reading-pipeline outline 书.txt
 *   npx dsh-reading-pipeline gettext  <url>
 *   npx dsh-reading-pipeline page     <url>
 *   npx dsh-reading-pipeline read     书.txt 第3章
 *   npx dsh-reading-pipeline index    build|inc|stat
 *   npx dsh-reading-pipeline search   "查什么" --k=5
 *
 * 约定：所有命令都在**当前目录**下工作（`--root=` 可改），配置写成 `./pipe.config.json`。
 * 不再要求把配置放进包目录——那样全局安装之后要去 node_modules 里改，是错的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const argOf = (k, d) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d
const rest = argv.filter((a) => !a.startsWith('--root='))

const ROUTES = {
  outline: 'book-outline.mjs',
  gettext: 'gettext.mjs',
  page: 'page-text.mjs',
  'page-text': 'page-text.mjs',
  read: 'read-x.mjs',
  readbook: 'readbook.mjs',
  index: 'doc-emb.mjs',
  search: 'doc-emb.mjs',
  'doc-emb': 'doc-emb.mjs',
  night: 'doc-emb-night.mjs',
}

function targetRoot() {
  return path.resolve(argOf('root', process.cwd()))
}

function say(s = '') { console.log(s) }

function install() {
  const root = targetRoot()
  const dirs = ['reading', 'learned', 'live']
  fs.mkdirSync(root, { recursive: true })
  for (const d of dirs) {
    const p = path.join(root, d)
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); say(`  建目录 ${d}/`) }
  }
  const cfgPath = path.join(root, 'pipe.config.json')
  if (!fs.existsSync(cfgPath)) {
    const ex = JSON.parse(fs.readFileSync(path.join(SRC, 'pipe.config.example.json'), 'utf8'))
    ex.root = ''
    ex._说明 = '第一次 install 自动生成。root 留空 = 用当前目录；embed.mode: auto=远端不通就退回内置哈希，remote=只准用远端，local=只用内置'
    ex.embed.mode = ex.embed.mode || 'auto'
    fs.writeFileSync(cfgPath, JSON.stringify(ex, null, 2) + '\n', 'utf8')
    say('  写配置 pipe.config.json')
  } else {
    say('  配置已存在，没动它')
  }
  say(`\n装好了：${root}`)
  say('下一步：把 .md 笔记放进 reading/ 或 learned/，然后')
  say('  reading-pipeline index build')
  say('  reading-pipeline search "查什么"\n')
  doctor()
}

async function doctor() {
  const root = targetRoot()
  const cfgPath = path.join(root, 'pipe.config.json')
  const cfg = fs.existsSync(cfgPath)
    ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    : (fs.existsSync(path.join(SRC, 'pipe.config.json')) ? JSON.parse(fs.readFileSync(path.join(SRC, 'pipe.config.json'), 'utf8')) : {})
  say(`体检 · ${PKG.name}@${PKG.version} · 根目录 ${root}`)

  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20
  say(`  ${nodeOk ? '✅' : '❌'} Node ${process.versions.node}${nodeOk ? '' : '（要 ≥ 20）'}`)

  for (const d of ['reading', 'learned', 'live']) {
    const ok = fs.existsSync(path.join(root, d))
    say(`  ${ok ? '✅' : '⚠️'} 目录 ${d}/${ok ? '' : '（跑 install 会建）'}`)
  }
  say(`  ${fs.existsSync(cfgPath) ? '✅' : '⚠️'} 配置 ${fs.existsSync(cfgPath) ? cfgPath : '（没有，用默认值；跑 install 生成）'}`)

  // ws：page 命令才需要，缺了不算错
  let wsOk = false
  try { const m = await import('ws'); wsOk = !!(m.default || m.WebSocket) } catch {}
  const natWs = typeof globalThis.WebSocket === 'function'
  say(`  ${wsOk ? '✅' : natWs ? '✅' : '⚠️'} WebSocket：${wsOk ? 'ws 包' : natWs ? 'Node 自带（够用；ws 只是更快）' : '都没有（page 命令用不了，npm i ws）'}`)

  const exe = cfg?.browser?.exe || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  say(`  ${fs.existsSync(exe) ? '✅' : '⚠️'} 浏览器 ${exe}${fs.existsSync(exe) ? '' : '（page 命令要它，或改 browser.exe）'}`)

  const ep = cfg?.embed?.endpoint || 'http://127.0.0.1:18081/v1/embeddings'
  const mode = cfg?.embed?.mode || 'auto'
  let remote = null
  try {
    const r = await fetch(ep, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: ['ping'], model: cfg?.embed?.model || 'probe' }),
      signal: AbortSignal.timeout(1500),
    })
    remote = r.ok ? (await r.json())?.data?.[0]?.embedding?.length || '?' : `HTTP ${r.status}`
  } catch (e) { remote = e.name === 'TimeoutError' ? '超时' : e.message }

  if (mode === 'local') say(`  ✅ 嵌入：内置哈希（embed.mode=local）`)
  else if (remote && typeof remote === 'number' || (remote && remote !== '?' && !String(remote).startsWith('HTTP'))) {
    say(`  ✅ 嵌入：远端 ${ep}（${remote} 维）`)
  } else {
    say(`  ${mode === 'auto' ? '⚠️' : '❌'} 嵌入：远端不通（${remote}）${mode === 'auto' ? '→ 会自动退回内置哈希，只认字面' : '，mode=remote 不允许降级'}`)
  }
  say('\n嵌入两种模式的差别：远端模型（如 bge）能按**意思**搜；内置哈希只认**字面**，同义词搜不到。')
}

async function main() {
  const cmd = rest[0]
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    say(`reading-pipeline ${PKG.version} —— 把「读一本书」变成「读完留下可检索的东西」`)
    say('')
    say('  install            建目录 + 写配置 + 体检（幂等）')
    say('  doctor             只体检')
    say('  outline <书.txt>   出章节目录')
    say('  gettext <url>      抓静态页正文')
    say('  page    <url>      用真浏览器抽正文（动态页）')
    say('  read    <书> <章>  读指定章节')
    say('  index   build|inc|stat   向量索引')
    say('  search  "…"        按意思搜回原句')
    say('')
    say('公共参数：--root=目录（默认当前目录）')
    return
  }
  if (cmd === 'install') return install()
  if (cmd === 'doctor') return doctor()
  const file = ROUTES[cmd]
  if (!file) {
    console.error(`不认识的命令：${cmd}。跑 reading-pipeline help 看清单。`)
    process.exit(2)
  }
  if (!fs.existsSync(path.join(SRC, file))) {
    console.error(`包里缺 ${file}，安装不完整，重装一次`)
    process.exit(1)
  }
  // search 在 doc-emb 里是个子命令，前面要补上；其余脚本本来就是单命令
  const sub = cmd === 'search' ? ['search'] : []
  const r = spawnSync(process.execPath, [path.join(SRC, file), ...sub, ...rest.slice(1)], { stdio: 'inherit', cwd: targetRoot() })
  process.exit(r.status ?? 1)
}

await main()
