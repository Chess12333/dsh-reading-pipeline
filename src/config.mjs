import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 找配置文件。2026-11-07 改：原来四份脚本都写死 `new URL('./pipe.config.json', import.meta.url)`，
 * 也就是**配置必须躺在包目录里**——全局装（npm i -g）之后那个位置是 node_modules，
 * 让人去那儿改配置是错的；解压到只读目录更是直接写不进去。
 * 现在的顺序：环境变量 → 当前目录 → 包根目录 → src/。先找到先用。
 */
export function configPath() {
  const cands = [
    process.env.READING_CONFIG,
    path.join(process.cwd(), 'pipe.config.json'),
    path.join(HERE, '..', 'pipe.config.json'),
    path.join(HERE, 'pipe.config.json'),
  ].filter(Boolean)
  for (const p of cands) if (fs.existsSync(p)) return p
  return null
}

export function loadCfg() {
  const p = configPath()
  if (!p) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`配置文件读不了：${p}（${e.message}）`)
    return {}
  }
}

export { HERE }
