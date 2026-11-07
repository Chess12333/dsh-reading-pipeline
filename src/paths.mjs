// paths.mjs —— 转书那两步（to-txt / convert-all）共用的一份路径配置
//
// 2026-11-07 从「读书工具-20261107.zip」并进来，改了三处：
//   ① 配置来源接回本包的 config.mjs（环境变量 → 当前目录 → 包根），不再只认包目录里的 config.json；
//   ② 键做兼容：中文（书库 / 转好的书存哪 / 进度记在哪）和英文（library / books / work）都认；
//   ③ 默认落点跟本包其他命令一致：书放 <root>/reading，中间产物放 <root>/live。
//
// 一次只做一件事：把配置读进来，读不对就停下来，说清楚哪一项错了。
// 填错不往下跑——宁可停在这儿报错，也不进去乱写文件。

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { HERE, loadCfg } from './config.mjs'

function die(msg) {
  console.error('')
  console.error('──── 停在这儿，没往下跑 ────')
  console.error(msg)
  console.error('')
  console.error(`配置文件在：${process.env.READING_CONFIG || path.join(process.cwd(), 'pipe.config.json')}`)
  console.error('拿记事本打开它，改完存盘再跑。')
  process.exit(1)
}

const cfg = loadCfg()

// 中文键优先（照搬过来的说明书就是这么写的），英文键其次
const get = (...keys) => {
  for (const k of keys) {
    const v = cfg[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  return ''
}

const root = path.resolve(cfg.root || process.cwd())
const 书库 = get('书库', 'library')
const 转好 = get('转好的书存哪', 'books')
const 进度 = get('进度记在哪', 'work')

if (!书库) {
  die('「书库」这一项还没填。\n把它填成你的电子书放在哪个目录，例如：\n  "书库": "E:/文件/书库"')
}
if (/[<>|?*]/.test(书库)) {
  die(`「书库」里有不能出现在路径里的字符（< > | ? *）：${书库}`)
}
// 相对路径按 root 解析（装成插件之后，写 "books" 这种就是 <root>/books）
const 书库绝对 = path.isAbsolute(书库) || /^[A-Za-z]:/.test(书库) ? path.resolve(书库) : path.resolve(root, 书库)
if (!existsSync(书库绝对)) {
  die(`「书库」这个目录不存在：${书库绝对}\n可能是路径打错了，也可能那个盘还没插上。`)
}
if (!statSync(书库绝对).isDirectory()) {
  die(`「书库」填的是一个文件，不是目录：${书库绝对}\n这一项要填「放着书的文件夹」。`)
}

export const PATHS = {
  HERE,
  ROOT: root,
  LIBRARY: 书库绝对,
  BOOKS: 转好 ? path.resolve(转好) : path.join(root, 'reading'),
  WORK: 进度 ? path.resolve(进度) : path.join(root, 'live'),
}
