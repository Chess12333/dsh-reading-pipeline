#!/usr/bin/env node
// 按章号抽读小说：给文件+起始章+章数+每章窗口数，输出标题与均匀抽取的片段。
// 用法：node scripts\read-x.mjs <文件> <起始章> <章数> [每章窗口数=5]
import fs from 'node:fs';

const [, , file, fromRaw, countRaw, winRaw] = process.argv;
const from = Number(fromRaw), count = Number(countRaw), wins = Number(winRaw || 5);
if (!file || !from || !count) {
  console.error('用法: node scripts/read-x.mjs <文件> <起始章> <章数> [窗口数]');
  process.exit(1);
}
const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const re = /^第(\d+)章[\s　]/;
const starts = [];
lines.forEach((l, i) => { const m = re.exec(l.trim()); if (m) starts.push({ n: Number(m[1]), i, t: l.trim() }); });

function bodyOf(k) {
  const cur = starts.find(s => s.n === k);
  if (!cur) return null;
  const next = starts.find(s => s.i > cur.i);
  const end = next ? next.i : lines.length;
  const body = lines.slice(cur.i + 1, end).filter(l => l.trim());
  return { title: cur.t, body };
}

for (let k = from; k < from + count; k++) {
  const ch = bodyOf(k);
  if (!ch) { console.log(`第${k}章 (缺)`); continue; }
  const n = ch.body.length;
  const out = [];
  // 开头 2 行
  out.push(...ch.body.slice(0, 2));
  if (n > 6) {
    // 中间均匀窗口
    const take = Math.min(wins, Math.max(1, Math.floor(n / 12)));
    for (let j = 1; j <= take; j++) {
      const idx = Math.floor((n * j) / (take + 1));
      out.push('…', ch.body[idx], ...(ch.body[idx + 1] ? [ch.body[idx + 1]] : []));
    }
    out.push('…', ...ch.body.slice(-2));
  } else out.push(...ch.body.slice(2));
  const text = out.join('\n').replace(/[\u200b\s]+/g, ' ');
  console.log(`\n### ${ch.title}（${n} 段）`);
  console.log(text.length > 900 ? text.slice(0, 620) + ' …[截]' : text);
}
