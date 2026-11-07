#!/usr/bin/env node
// scripts/gettext.mjs — 抓一个网页，只吐正文文字，默认截断
// 用法：node scripts/gettext.mjs <url> [--max=6000] [--sel=标题前缀] [--raw]
//   --max=N   最多输出 N 个字符（默认 6000，省钱用）
//   --sel=STR 只保留包含该字符串之后的部分（粗糙的定位）
//   --raw     不剥标签（调试用）
// 为什么有它：web_fetch 会把整页 JSON/HTML 塞进上下文，一次几千上万 token；
// 这里在本地剥干净、按需截断，只把要看的那几千字递上来。
import { argv } from 'node:process';

const url = argv[2];
if (!url || url.startsWith('--')) {
  console.error('用法: node scripts/gettext.mjs <url> [--max=6000] [--sel=前缀] [--raw]');
  process.exit(2);
}
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const max = Number(opt('max', 6000));
const sel = opt('sel', '');
const raw = argv.includes('--raw');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function strip(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const res = await fetch(url, {
  headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
  redirect: 'follow',
});
const html = await res.text();
let out = raw ? html : strip(html);
if (!raw) out = out.replace(/<[^>]*>/g, ' ');
if (sel) {
  const i = out.indexOf(sel);
  if (i >= 0) out = out.slice(i);
}
const plainLen = out.length;
const cut = plainLen > max;
out = out.slice(0, max);

const head = `[${res.status}] ${(res.headers.get('content-type') || '').split(';')[0]} | 原文 ${html.length} 字节 -> 正文 ${plainLen} 字`;
console.log(cut ? `${head}（截断到 ${max}，还有 ${plainLen - max} 字没出）` : head);
console.log(out);
