#!/usr/bin/env node
// book-outline.mjs —— 给一本 txt 小说出「目录地图」：章号、起始行、章名、字数。
// 用途：一百万字不可能逐字读，先看骨架（章名本身就在剧透），再挑章精读。
// 用法：node scripts\book-outline.mjs <书.txt> [--out=目录.md] [--chars=0]
//   --chars=N  在目录里额外附每章开头 N 个字（默认 0，只出章名）
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
if (!src) { console.error('用法: node scripts\\book-outline.mjs <书.txt> [--out=目录.md] [--chars=0]'); process.exit(1); }
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const out = opt('out', path.join(path.dirname(src), `_目录-${path.basename(src, '.txt')}.md`));
const headChars = Number(opt('chars', '0'));

const text = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const lines = text.split('\n');
const title = (lines[0] || '').trim() || path.basename(src, '.txt');
const stamp = (lines[1] || '').trim();

const CH = /^第\s*[0-9０-９一二三四五六七八九十百千零两]+\s*[章回节]/;
const idx = [];
for (let i = 0; i < lines.length; i++) if (CH.test(lines[i].trim())) idx.push(i);

const rows = idx.map((start, n) => {
  const end = n + 1 < idx.length ? idx[n + 1] : lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  const chars = body.replace(/\s/g, '').length;
  const head = headChars ? body.replace(/\s+/g, ' ').trim().slice(0, headChars) : '';
  return { n: n + 1, line: start + 1, name: lines[start].trim(), chars, head };
});

const total = text.replace(/\s/g, '').length;
const md = [
  `# ${title} · 目录地图`,
  stamp ? `\n${stamp}` : '',
  `\n总字数 ${total}，共 ${rows.length} 章，平均 ${rows.length ? Math.round(total / rows.length) : 0} 字/章。行号从 1 起。`,
  '',
  '| # | 行号 | 章名 | 字数 |' + (headChars ? ' 开头 |' : ''),
  '|---|---|---|---|' + (headChars ? '---|' : ''),
  ...rows.map(r => `| ${r.n} | ${r.line} | ${r.name.replace(/\|/g, '/')} | ${r.chars} |${headChars ? ' ' + r.head.replace(/\|/g, '/') + ' |' : ''}`),
].join('\n');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md, 'utf8');
console.log(`OK ${out} | ${rows.length} 章 | ${total} 字`);
