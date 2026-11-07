#!/usr/bin/env node
import { loadCfg } from './config.mjs'
/**
 * doc-emb-night.mjs —— 夜里把档案的向量索引增量刷一遍（2026-11-01 立）
 *
 * 起因：她 17:36 说的「每天夜间蒸馏（23:20）的时候做新文件增量吧」。
 * 索引 `live/doc-emb.f32` 原来只能手动 build/inc，白天写的日记、见闻、梦稿进不去，
 * 按意思搜就等于只搜到"昨天以前的我"。
 *
 * 为什么单独一个包装脚本、而不是直接让计划任务调 doc-emb.mjs inc：
 *   ① 要留一行日志（live/doc-emb.log）——没有产物的任务，「跑没跑」和「跑成功了没」分不出来；
 *   ② 要先探一次嵌入服务（127.0.0.1:18081）。服务不在时 inc 会失败，而失败必须是响的，
 *      不能像 2026-11-01 之前那样写零向量进索引——那种坏法不报错，只是搜不到东西。
 *
 * 用法：
 *   node scripts\doc-emb-night.mjs          # 探服务 → inc → 记一行
 *   node scripts\doc-emb-night.mjs --force  # 服务探活也失败时照样硬跑（排查用）
 *
 * 退出码：0 成功 / 1 服务不在或 inc 失败（计划任务的「上次结果」直接看得见）
 * 日志：live\doc-emb.log（一行一次，带日期时间；due-tasks 用它的最后一行判索引新不新）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const __CFG = loadCfg()
const ROOT = process.env.READ_ROOT || __CFG.root || process.cwd();
const LOG = path.join(ROOT, 'live', 'doc-emb.log');
const ENDPOINT = process.env.EMB_ENDPOINT || 'http://127.0.0.1:18081/v1/models';
const force = process.argv.includes('--force');

const pad = (n) => String(n).padStart(2, '0');
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch { /* 日志都写不了就算了，别把任务本身弄挂 */ }
}

/** 3 秒探活：连不上 / 超时 / 非 2xx 都算不在 */
async function alive() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  try {
    const r = await fetch(ENDPOINT, { signal: ac.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const ok = await alive();
  if (!ok && !force) {
    log(`${stamp()}  SKIP  嵌入服务不在（${ENDPOINT}），这次没跑`);
    console.log('嵌入服务不在，跳过（索引没动）');
    return 1;
  }
  if (!ok && force) log(`${stamp()}  WARN  服务探活失败，--force 硬跑`);

  const res = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', 'doc-emb.mjs'), 'inc'],
      { cwd: ROOT, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });

  if (res.err) {
    const why = (res.stderr.trim().split('\n').pop() || res.err.message || '').slice(0, 200);
    log(`${stamp()}  FAIL  ${why}`);
    console.log('inc 失败：' + why);
    return 1;
  }
  const tail = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '（没输出）';
  log(`${stamp()}  OK  ${tail.slice(0, 160)}`);
  console.log(tail);
  return 0;
}

process.exit(await main());
