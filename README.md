# dsh-reading-pipeline

把「读一本书」变成「读完留下可检索的东西」。

四步：**抓正文 → 出目录挑章节 → 读，压成自己的话 → 按意思查回原句**。
中间那一步没有脚本，是模型自己读、自己写笔记——这是整套东西的关键，也是唯一不能自动化的部分。

```
电子书 ──→ 取正文 ──→ 切块/切章 ──→ 读，压成自己的话 ──→ 按意思查回原句
convert    gettext                    （你自己，格式见
convert-all  page     →  outline        notes-format.md）     → index + search
```

---

## 装

```bash
# 全局装（推荐）
npm i -g dsh-reading-pipeline

# 或者不装，直接用
npx dsh-reading-pipeline install
```

然后在**你要放书的那个目录**里跑一次：

```bash
reading-pipeline install
```

它会做三件事，全自动、可重跑（幂等）：
1. 建 `reading/`、`learned/`、`live/` 三个目录
2. 写一份 `./pipe.config.json`（已存在就不动它）
3. 体检：Node 版本、目录、配置、WebSocket、浏览器、嵌入服务

**不需要手动建目录，也不需要手动跑 `node scripts/xxx.mjs`。**
`install` 之后所有命令都在当前目录工作，`--root=目录` 可以指定别处。

## 用

```bash
reading-pipeline convert 书库/某本.epub    # 电子书 → txt（epub / pdf 文本层 / txt 换编码）
reading-pipeline convert-all              # 把书库整批转成 txt（--dry 只看清单）
reading-pipeline outline 书.txt        # 章号 / 起始行 / 章名 / 字数，先看骨架再挑章节
reading-pipeline gettext https://…     # 静态页正文（剥标签，默认截 6000 字）
reading-pipeline page    https://…     # 动态页正文（真浏览器渲染，知乎/贴吧这类用它）
reading-pipeline read    书.txt 第3章  # 读指定章节，打出来
reading-pipeline index   build         # 建向量索引（inc = 增量，stat = 看统计）
reading-pipeline search  "局部处理为什么要乘上数量"
reading-pipeline doctor                # 只体检，不改东西
```

## 电子书转成 txt（`convert` / `convert-all`）

| 格式 | 结果 |
|---|---|
| `.txt` | 换编码：UTF-8 / GB18030 自动认，统一成 UTF-8 |
| `.epub` | 解 zip、按 spine 顺序拼正文、剥标签。**零依赖**，不调外部命令 |
| `.pdf` | 只试文本层；扫描件抽不出就明说，不做 OCR |
| `.mobi` / `.azw3` | 不转，给一句原因——先自己转成 epub 或 txt |

书库填在 `书库`（英文键 `library`）里，相对路径按 `root` 解析；`转好的书存哪`（`books`）留空就落在 `<root>/reading`，正好是 `outline` 和 `readbook` 找书的地方。整库转的时候 `--dry` 只列清单，真转完会给「成功 / 认不出章名 / 转不了 + 原因」三档。

> 这一段是 2026-11-07 从一份别人给的「读书工具-20261107.zip」里**并进来**的（原作者署名：工程师安菲）。合并时只动了三处：配置接回本包（原来是脚本旁边的 `config.json`）、解压改用内置 zip 解析（系统 `tar` 在 GNU 版下解不了 zip，实测报 `This does not look like a tar archive`）、清单口径跟 `to-txt` 的真实能力对齐（原来代码写着支持 pdf/mobi，说明书说不行）。

## 配置（`pipe.config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `""` | 留空 = 当前目录 |
| `书库` / `library` | `""` | 电子书目录，`convert-all` 从这儿扫。相对路径按 `root` 解析；两项是同一个键的中英文写法，填一个就行 |
| `转好的书存哪` / `books` | `""` | 转出来的 txt 放哪；空 = `<root>/reading` |
| `进度记在哪` / `work` | `""` | `readbook` 的进度与切出来的段落放哪；空 = `<root>/live` |
| `dirs` | `[["reading","reading"],["learned","learned"]]` | 哪几个目录进索引；每项 `[目录名, 标签]` |
| `embed.endpoint` | `http://127.0.0.1:18081/v1/embeddings` | 任何 **OpenAI 兼容**的嵌入接口都行 |
| `embed.model` | `bge-base-zh-v1.5-q8_0` | 传给上面那个接口的 model 名 |
| `embed.dim` | `768` | 必须和接口真实返回的维度一致，不一致会写坏索引 |
| `embed.mode` | `auto` | `auto` 远端不通就退回内置；`remote` 只准用远端；`local` 只用内置 |
| `embed.chars` | `400` | 每块多少字（重叠 80）。**不足 40 字的块会被跳过**——短笔记进不了索引，build 会提示 |
| `browser.exe` | Edge 默认路径 | `page` 命令用的浏览器 |
| `browser.profile` | `./.browser-profile` | **独立 profile 目录**，别指向你日常那个 |
| `browser.port` | `9222` | 调试端口 |
| `browser.wsModule` | `""` | WebSocket 从哪儿来，见下 |

## 嵌入服务：两种模式，代价不同

第四步要算向量，这件事需要一个嵌入模型。两种走法：

| | 远端模型（如 bge） | 内置退化嵌入 |
|---|---|---|
| 怎么来 | 你自己起一个 OpenAI 兼容服务，配 `embed.endpoint` | 不用起，进程内自带（`src/embed-local.mjs`） |
| 能不能按**意思**搜 | 能（同义词、换说法都搜得到） | **不能**，只认字面（字符 n-gram 哈希） |
| 依赖 | 那个服务 + 模型权重 | 零依赖、离线 |
| 什么时候用 | 想真检索 | 想先跑通、或者机器上什么都没有 |

`embed.mode: auto`（默认）下，远端不通会**自动**退回内置，并打印一行说明。
退回是兜底，不是等价——它会把「近义」当成「不相关」。

**两种模式建的索引不能混着查**：向量不在同一个空间里，分数看着正常、其实全错。
索引清单里记了 `mode`/`dim`，混用会被直接拦下并让你重建，不会给你一堆假高分。

想单独把内置服务当接口用：

```bash
node src/embed-local.mjs --port=18081 --dim=768
```

## WebSocket（只有 `page` 命令需要）

顺序是死的：**先试 `ws` 包，装不上就退回 Node 自带的全局 WebSocket（Node ≥ 22）**。

- `ws` 包：接口是 `.on('open'|'message'|'error')`。
- 自带的那套：只有 `addEventListener`，没有 `.on()`。代码里给它包了一层，外部行为一样。
- 两样都没有 → 报错并告诉你 `npm i ws`（这是 `page` 命令唯一的外部依赖，装不上也不影响其余五个命令）。

`browser.wsModule` 留空 = 走上面这条顺序；填了就用你指的那个模块（绝对路径或 `file://` URL 都行）。

## 当 DSH 插件用

这个包同时也是个 DSH 插件（`dsh.plugin.json` + `cordis.patch.yml`），注册四个工具，
全部 shell 到同一个 CLI，没有第二份实现：

| 工具 | 干什么 |
|---|---|
| `reading_outline` | 出一本书的章节目录 |
| `reading_index` | `build` / `inc` / `stat` |
| `reading_search` | 按意思搜回原句 |
| `reading_page_text` | 真浏览器抽正文 |

CLI 和插件只是两个入口，逻辑只有一份。

## 边界（这几条不会变）

- **不做登录**，只读公开页面；拿不到就是拿不到，不猜。
- **不绕付费墙**，不拿别人的账号。
- 嵌入服务、浏览器都得你自己有；这个包不下载模型、不下载浏览器。
- `page` 会起一个可见的浏览器窗口（默认 Edge，独立 profile）。

## 目录

```
bin/reading-pipeline.mjs   统一入口（install / doctor / 六个命令）
src/index.js               DSH 插件入口（四个工具，薄壳）
src/config.mjs             配置查找：环境变量 → 当前目录 → 包根目录 → src/
src/embed-local.mjs        内置退化嵌入 + /v1/embeddings 小服务
src/doc-emb.mjs            索引与检索（build / inc / stat / search）
src/book-outline.mjs       章节目录
src/gettext.mjs            静态页正文
src/page-text.mjs          动态页正文（真浏览器）
src/readbook.mjs           按章读
src/read-x.mjs             按窗口读
notes-format.md            笔记格式：三本册子怎么分、一条笔记长什么样
```

## License

MIT。笔记是你自己的，这个包不碰你的数据。
