/**
 * dsh-reading-pipeline —— DSH 插件入口（薄壳）
 *
 * 这个包的主要形态是 CLI；插件只是把命令行里最常用的三件事变成工具，
 * 免得模型为了跑一条命令去拼路径。**逻辑一律不在这里重写**，
 * 全部 shell 到 `bin/reading-pipeline.mjs`——一份实现，两个入口。
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

export const name = 'dsh-reading-pipeline'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'bin', 'reading-pipeline.mjs')

function runCli(args, root, timeoutMs = 120_000) {
  const cwd = root && fs.existsSync(root) ? path.resolve(root) : process.cwd()
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: timeoutMs })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  if (r.error) throw new Error(`跑不动 ${['reading-pipeline', ...args].join(' ')}：${r.error.message}`)
  return { ok: r.status === 0, code: r.status, cwd, output: out.length > 12_000 ? out.slice(0, 12_000) + '\n…（截断）' : out }
}

export function apply(ctx) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'reading_outline',
    description: '给一本书出章节目录（章号/起始行/章名/字数），用来挑章节精读，不必逐字读完。文件是纯文本 txt。',
    parameters: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '书文件路径（绝对，或相对当前目录）' },
        chars: { type: 'number', description: '目录里附每章开头几个字，默认 0' },
        root: { type: 'string', description: '工作目录（默认当前目录）' },
      },
      required: ['book'],
      additionalProperties: false,
    },
    execute(args) {
      const a = ['outline', args.book]
      if (args.chars) a.push(`--chars=${args.chars}`)
      if (args.root) a.push(`--root=${args.root}`)
      return runCli(a, args.root)
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'reading_index',
    description: '给笔记目录建/更新向量索引（build=全量，inc=增量，stat=看统计）。远端嵌入服务不通时会自动退回内置的字面哈希嵌入，并在结果里说明。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['build', 'inc', 'stat'], description: '默认 inc' },
        root: { type: 'string', description: '工作目录（默认当前目录）' },
      },
      required: [],
      additionalProperties: false,
    },
    execute(args) {
      const a = ['index', args.action || 'inc']
      if (args.root) a.push(`--root=${args.root}`)
      return runCli(a, args.root, 1_800_000)
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'reading_search',
    description: '按意思搜回原句：在已建好的向量索引里查，返回文件、位置和片段。索引是用哪种嵌入模式建的，就用哪种模式查（混用会被拦下）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的意思（不是关键词也行）' },
        k: { type: 'number', description: '返回几条，默认 5' },
        root: { type: 'string', description: '工作目录（默认当前目录）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute(args) {
      const a = ['search', args.query]
      if (args.k) a.push(`--k=${args.k}`)
      if (args.root) a.push(`--root=${args.root}`)
      return runCli(a, args.root)
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'reading_page_text',
    description: '用真实浏览器打开一个页面并抽正文（动态渲染、反爬的站用它；静态站用 gettext）。不做登录。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '页面地址' },
        max: { type: 'number', description: '最多返回多少字，默认 8000' },
        wait: { type: 'number', description: '导航后等多少毫秒再抽，默认 4000' },
        root: { type: 'string', description: '工作目录（默认当前目录）' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execute(args) {
      const a = ['page', args.url]
      if (args.max) a.push(`--max=${args.max}`)
      if (args.wait) a.push(`--wait=${args.wait}`)
      if (args.root) a.push(`--root=${args.root}`)
      return runCli(a, args.root, 180_000)
    },
  }))

  return () => { for (const d of disposers) { try { d?.() } catch {} } }
}
