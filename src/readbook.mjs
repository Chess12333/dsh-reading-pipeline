#!/usr/bin/env node
import { loadCfg } from './config.mjs'
/**
 * 一次读多章。2026-10-25 浔定的：「自由活动时间小说轮最少十章起步，一章一章看没什么用」。
 * 2026-10-26 11:16 浔改：「每次阅读小说改为20章，10章看的太慢了」——默认值改成 20。
 *
 * 用法：
 *   node scripts\readbook.mjs 部族荣光                 # 从上次停的地方起，读 20 章
 *   node scripts\readbook.mjs 部族荣光 --from=30       # 从第 30 章起
 *   node scripts\readbook.mjs 部族荣光 --count=20      # 读 20 章
 *   node scripts\readbook.mjs 部族荣光 --list          # 只看目录，不落文件
 *   node scripts\readbook.mjs 部族荣光 --dry           # 只回报范围与字数，不写文件
 *   node scripts\readbook.mjs 部族荣光 --mark=114      # 只记「读到第 114 章」，不切章、不动 cut
 *   node scripts\readbook.mjs 部族荣光 --mark=114 --note="这一批的收获"
 *
 *   2026-11-02 12:1x 加 --mark 与参数白名单。起因：我敲了 --mark=114，脚本不认识它，
 *   静默忽略，按默认从左到右切了 20 章（109→134），还把 cut 推到 134——账上多出二十章
 *   没读过的「已切」，下次会从 135 开始，115–134 永远读不到。现在不认识的参数直接 exit 2。
 *
 * 它做三件事：切章 → 合成一个 batch 文件（live\read\<书>_<起>-<止>.txt）→ 记进度（live\read\progress.json）。
 * 输出末尾打印一份目录（章号、标题、字数），我按它判断值不值得读进去。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

const __CFG = loadCfg()
const ROOT = process.env.READ_ROOT || __CFG.root || process.cwd();
const READING = path.join(ROOT, 'reading');
const OUTDIR = path.join(ROOT, 'live', 'read');
const PROGRESS = path.join(OUTDIR, 'progress.json');

const argv = process.argv.slice(2);
const want = argv.find((a) => !a.startsWith('--'));
const num = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const has = (k) => argv.includes(`--${k}`);

if (!want) {
  console.error('用法: node scripts\\readbook.mjs <书名|文件路径> [--from=N] [--count=20] [--mark=N] [--list] [--dry]');
  process.exit(2);
}

// 2026-11-02 12:1x：参数白名单。原来不认识的参数被静默忽略——我今天敲了 --mark=114，
// 它当没看见，按默认从 109 切了 20 章到 134，还把 cut 推到了 134。
// 静默忽略最坏的地方不是做错，是**看起来做对了**：退出码 0、输出正常，只有对数才发现错。
const KNOWN = new Set(['from', 'count', 'list', 'dry', 'mark', 'note', 'help']);
const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN.has(a.slice(2).split('=')[0]));
if (unknown.length) {
  console.error(`不认识的参数：${unknown.join(' ')}\n支持：${[...KNOWN].map((k) => '--' + k).join(' ')}`);
  process.exit(2);
}
if (has('help')) {
  console.log('用法: node scripts\\readbook.mjs <书名|文件路径> [--from=N] [--count=20] [--mark=N] [--note=…] [--list] [--dry]');
  console.log('  --mark=N   只把「读到第 N 章」记进 progress（不切章、不动 cut）');
  process.exit(0);
}

// 1. 找文件
let file = want;
if (!existsSync(file)) {
  const cands = (existsSync(READING) ? readdirSync(READING) : []).filter((f) =>
    f.toLowerCase().endsWith('.txt')
  );
  const hit = cands.filter((f) => f.includes(want) || want.includes(f.replace(/\.txt$/i, '')));
  if (hit.length === 0) {
    console.error(`reading\\ 下没有匹配「${want}」的书。现有：\n  ` + cands.join('\n  '));
    process.exit(2);
  }
  if (hit.length > 1) {
    console.error('匹配到多本，说清楚点：\n  ' + hit.join('\n  '));
    process.exit(2);
  }
  file = path.join(READING, hit[0]);
}

// 2. 切章
const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/);
const CH = /^第\s*([0-9０-９一二三四五六七八九十百千零两]+)\s*章[\s　]*(.*)$/;
const heads = [];
for (let i = 0; i < lines.length; i++) {
  const m = CH.exec(lines[i].trim());
  if (m) heads.push({ no: m[1], title: m[2].trim(), line: i });
}
if (heads.length === 0) {
  console.error('这本里没找到「第N章」的章节标记，切不开。');
  process.exit(1);
}
const chapters = heads.map((h, i) => ({
  idx: i + 1, // 按出现顺序，比章号本身更可靠（有的书编号乱）
  no: h.no,
  title: h.title,
  start: h.line,
  end: i + 1 < heads.length ? heads[i + 1].line : lines.length,
}));
chapters.forEach((c) => {
  c.text = lines.slice(c.start, c.end).join('\n').trim();
  c.chars = c.text.replace(/\s/g, '').length;
});

// 3. 起止
mkdirSync(OUTDIR, { recursive: true });
let progress = {};
try { progress = JSON.parse(readFileSync(PROGRESS, 'utf8')); } catch { }
const bookKey = path.basename(file, '.txt');

// --mark=N：只记账「读到第 N 章」，不切章、不动 cut。
// 2026-11-02 12:1x 加：读完一批之后要更新 read，原来只能手搓 node -e 改 json，
// 手搓就会写错（而且没有校验，114 也能写成 1114）。
if (Number.isFinite(num('mark', NaN))) {
  const mark = num('mark', NaN);
  if (!Number.isInteger(mark) || mark < 1 || mark > chapters.length) {
    console.error(`--mark=${mark} 越界：这本共 ${chapters.length} 章。`);
    process.exit(2);
  }
  const prev = progress[bookKey] || {};
  const noteArg = argv.find((a) => a.startsWith('--note='));
  progress[bookKey] = {
    ...prev,
    read: mark,
    readAt: new Date().toLocaleString('sv-SE').slice(0, 16),
  };
  if (noteArg) progress[bookKey].note = noteArg.slice(noteArg.indexOf('=') + 1);
  writeFileSync(PROGRESS, JSON.stringify(progress, null, 1), 'utf8');
  console.log(`只记进度：${bookKey} 读到第 ${mark} 章（cut 仍是 ${prev.cut ?? '未切'}，这一趟没切新章）`);
  process.exit(0);
}

const last = progress[bookKey]?.cut ?? progress[bookKey]?.last ?? 0; // 从「已切到」接着切
const from = Math.max(1, num('from', last + 1));
const count = Math.max(1, num('count', 20));
const pick = chapters.filter((c) => c.idx >= from && c.idx < from + count);

if (pick.length === 0) {
  console.error(`从第 ${from} 章起没有内容了（这本共 ${chapters.length} 章）。`);
  process.exit(1);
}
const totalChars = pick.reduce((s, c) => s + c.chars, 0);

if (has('list')) {
  console.log(`${bookKey}：共 ${chapters.length} 章，读到这里：${last}`);
  pick.forEach((c) => console.log(`  第${c.idx}章 ${c.title}  ${c.chars}字`));
  process.exit(0);
}

const outName = `${bookKey}_${pick[0].idx}-${pick[pick.length - 1].idx}.txt`;
const outPath = path.join(OUTDIR, outName);

console.log(`${bookKey}：共 ${chapters.length} 章，从第 ${pick[0].idx} 章读到第 ${pick[pick.length - 1].idx} 章`);
console.log(`  合计 ${pick.length} 章 / ${totalChars} 字`);
pick.forEach((c) => console.log(`  第${c.idx}章 ${c.title}  ${c.chars}字`));

if (has('dry')) {
  console.log('（--dry：没有落文件）');
  process.exit(0);
}

// 2026-11-03 07:1x：顺手落一份章→行号的索引（`<文件>.idx.json`）。
// 起因：读 161–180 那批时，为了跳到某一章得先 grep 一遍章名再数行，一轮里做了两次。
// 注意：这是**位置**指针，只对这份切好的文件有效（文件是整份重生成的，不会中途插章），
// 别把它当成能跨版本用的东西——跟「（同上）」那种靠相邻性的指针不是一回事。
const parts = [];
const chapterIndex = [];
let curLine = 1;
for (const c of pick) {
  const n = c.text.split(/\r?\n/).length;
  chapterIndex.push({ idx: c.idx, title: c.title, chars: c.chars, lineFrom: curLine, lineTo: curLine + n - 1 });
  parts.push(c.text);
  curLine += n + 1; // join('\n\n') 在章与章之间留一行空行
}
writeFileSync(outPath, parts.join('\n\n'), 'utf8');
writeFileSync(outPath.replace(/\.txt$/i, '') + '.idx.json', JSON.stringify({ book: bookKey, file: outName, chapters: chapterIndex }, null, 1), 'utf8');
// 2026-10-26：这里记的是「已切到第几章」，不是「读完了第几章」——切出来不等于读了。
// 原来那行打印成「进度：读到第 X 章」，等于替自己作假账；现在两个字段分开：
//   cut  = 已切到（下次 --from=cut+1）
//   read = 真读完到（只有我手动改，或者以后加 --done 再自动写）
const prev = progress[bookKey] || {};
progress[bookKey] = { ...prev, cut: pick[pick.length - 1].idx, at: new Date().toISOString().slice(0, 10), file: outName };
if (typeof prev.last === 'number' && typeof prev.read !== 'number') progress[bookKey].read = prev.last; // 老字段迁移
writeFileSync(PROGRESS, JSON.stringify(progress, null, 1), 'utf8');
console.log(`\n落盘：${outPath}`);
console.log(`已切到第 ${progress[bookKey].cut} 章（读没读完另算，progress.json 里的 read 才是真进度）`);
