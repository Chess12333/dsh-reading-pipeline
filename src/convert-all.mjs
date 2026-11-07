// convert-all.mjs —— 把书库里所有能转的书一次转完
//
// 用法：
//   reading-pipeline convert-all                 转配置里填的书库
//   reading-pipeline convert-all "D:/别的书库"    临时换一个目录，不改配置
//   reading-pipeline convert-all --dry           只看清单，不动手
//   node src/convert-all.mjs …                   直接跑也认
//
// 它干的事：扫目录里所有电子书 → 一本一本交给 to-txt.mjs → 汇总成败。
// 转不了的说清楚为什么转不了，不假装成功。
// 从哪跑都行，它不靠当前目录。
//
// 2026-11-07 工程师安菲 写的；同日并进本包，改了三处：
//   · 配置走 ./paths.mjs（本包的配置查找），不再只认包目录里的 config.json；
//   · SUPPORTED 与 to-txt 的真实能力对齐：pdf 只试文本层，mobi/azw3 直接给原因——
//     原来代码里写着「支持」而说明书写「不行」，两处打架；
//   · 汇总写清楚落在哪个目录（BOOKS），原来写死「books/」。

import { readdirSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { argv, execPath } from 'node:process';
import { PATHS } from './paths.mjs';

const OUT = PATHS.BOOKS;
// 真能转的：txt 换编码 / epub 解压拼正文 / pdf 试文本层（扫描件抽不出字会明说）
const SUPPORTED = ['.txt', '.epub', '.pdf'];
// 扫到也不转的：给一句原因，别让它们悄悄消失
const SKIP = ['.mobi', '.azw3'];

const args = argv.slice(2);
const dry = args.includes('--dry');
// 命令行给了目录就用命令行那个，没给就用配置里填的
const root = args.find((a) => !a.startsWith('--')) || PATHS.LIBRARY;

function walk(dir) {
  const out = [];
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) {
      // 漫画之类的大目录不往里钻，省时间
      if (/漫画|images?|pictures?/i.test(it.name)) continue;
      out.push(...walk(p));
    } else if (SUPPORTED.includes(extname(it.name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(root);
if (files.length === 0) {
  console.error(`这个目录里没找到能转的电子书：${root}`);
  console.error(`能转这几种：${SUPPORTED.join(' ')}（扫描版 pdf 抽不出字，会逐本说明）`);
  console.error(`转不了的：${SKIP.join(' ')}——先把它们转成 epub 或 txt 再放进来`);
  console.error('如果书在更深的子目录里，脚本会自己往下找；找不到就是真没有。');
  process.exit(1);
}

console.log(`书库：${root}`);
console.log(`转好的落在：${OUT}`);
console.log(`找到 ${files.length} 本。${dry ? '只看不动手。' : ''}\n`);
if (dry) {
  for (const f of files) console.log('  ' + basename(f));
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

const ok = [];
const bad = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const label = `[${i + 1}/${files.length}] ${basename(f)}`;
  const r = spawnSync(execPath, [join(PATHS.HERE, 'to-txt.mjs'), f, `--out=${OUT}`], {
    encoding: 'utf8',
    timeout: 300000,
  });
  const outText = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) {
    const m = /来源：(.+?) · (\d+) 字/.exec(outText);
    const ch = /认到章标记 (\d+) 个/.exec(outText);
    const chars = m ? Number(m[2]) : 0;
    const chapters = ch ? Number(ch[1]) : 0;
    // epub 常见的坑：转出来有字数，但几乎全是版权页/广告页
    if (chars < 2000) {
      bad.push({ file: basename(f), why: `只转出 ${chars} 字，太少了（可能是扫描件或目录页）` });
      console.log(`${label}  ⚠ 只有 ${chars} 字`);
    } else {
      ok.push({ file: basename(f), chars, chapters });
      console.log(`${label}  ✓ ${chars} 字${chapters ? `，${chapters} 章` : '，认不出章名'}`);
    }
  } else {
    const reason = (outText.trim().split(/\r?\n/).pop() || '未知原因').slice(0, 80);
    bad.push({ file: basename(f), why: reason });
    console.log(`${label}  ✗ ${reason}`);
  }
}

console.log('\n──────── 汇总 ────────');
console.log(`转成 ${ok.length} 本，失败 ${bad.length} 本。`);
if (ok.length) {
  console.log(`\n能用的（在 ${OUT}）：`);
  const withCh = ok.filter((x) => x.chapters > 0);
  const noCh = ok.filter((x) => x.chapters === 0);
  for (const x of withCh) console.log(`  ${x.file}  ${x.chars} 字 / ${x.chapters} 章`);
  if (noCh.length) {
    console.log('\n正文转了、但认不出章名的（能整本看，切不开章）：');
    for (const x of noCh) console.log(`  ${x.file}  ${x.chars} 字`);
  }
}
if (bad.length) {
  console.log('\n转不了的：');
  for (const x of bad) console.log(`  ${x.file}  —— ${x.why}`);
  console.log('\n扫描版 pdf 要 OCR 才能转，这台机器上没装，别硬试。');
}
