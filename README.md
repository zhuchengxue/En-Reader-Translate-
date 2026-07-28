# 英文原版书阅读器 (English E-book Reader)

一个隐私优先、纯前端的英文原版书阅读器，对标微信读书的学英语体验。支持 TXT / EPUB / PDF 三格式，单击取词查词、双击整句翻译、书内全文搜索、排版设置、离线可用，**零服务器成本**——所有数据只存在你自己的浏览器里。

## 特性

- **三格式阅读**：TXT（多列分页）/ EPUB（epub.js）/ PDF（pdf.js）。
- **取词查词**：单击单词弹出 Free Dictionary 释义 + 音标 + 真人发音（Web Speech API）。
- **整句翻译**：双击句子翻译为中文，默认走 MyMemory / Lingva，可配置自建 Cloudflare Worker 代理。
- **书内全文搜索**：三格式统一搜索接口，Ctrl/Cmd+F 唤起，结果高亮跳转（上限 200 条）。
- **排版设置**：行距（1.6 / 1.9 / 2.3）+ 版心宽度（760 / 1080 / 1440px）。
- **主题与统计**：明暗主题切换；阅读统计（今日分钟 / 连续天数 / 累计小时）。
- **离线可用**：Service Worker 缓存外壳；内置「版本守卫」自动检测并清理旧缓存后重载。
- **隐私优先**：书籍、笔记、生词、设置全部存于浏览器（IndexedDB + localStorage），不上传任何服务器。

## 技术栈

- 原生 JavaScript（ES Modules），**无构建步骤**，零依赖打包。
- epub.js + jszip（EPUB）/ pdf.js（PDF）/ 自定义 TXT 多列分页。
- Web Speech API（TTS）+ Free Dictionary API（查词）+ 翻译代理。
- 存储：IndexedDB（`db.js`）+ localStorage（设置 / 缓存）。
- 部署：静态托管（Cloudflare Pages / GitHub Pages / 任意静态服务器），含 Service Worker 离线壳。

## 快速开始

需要通过静态服务器访问（不能直接 `file://` 打开，Service Worker 要求 http(s) 环境）。

```bash
# 方式 A：Node（自带 no-cache 响应头，推荐）
node tools/serve.js
# 浏览器打开 http://localhost:9000

# 方式 B：任意静态服务器
npx serve .
# 或
python3 -m http.server 9000
```

打开后导入一本英文书（支持 TXT / EPUB / PDF，仓库 `samples/` 目录含测试样本），单击单词查词、双击句子翻译。

## 部署

纯静态站点，可托管到任意静态平台。仓库内置 Cloudflare Pages Function（`functions/api/translate.js`）提供同源翻译代理 `/api/translate`，部署后所有访客默认可用，无需各自配置。

### Cloudflare Pages（推荐）

- **连接 Git**：Workers 和 Pages → 创建 → Pages → 连接到 Git → 选择本仓库 → 框架预设选 `None`，构建命令与输出目录留空，根目录为仓库根 → 部署。
- **上传资产**：Workers 和 Pages → 创建 → Pages → 上传资产，拖入仓库根目录内容（`index.html` / `js` / `css` / `functions` …）即可。
- 完成后得到 `*.pages.dev` 公网地址，打开即用，翻译默认可用。

### GitHub Pages

仓库 **Settings → Pages → Source** 选择 `main` 分支、根目录（`/root`），得到 `*.github.io` 地址。

### 翻译代理（可选）

- 默认链路：Cloudflare 部署时走内置 `/api/translate`；本地或其他托管走免费公共 API（MyMemory / Lingva）。
- 想要更快更稳：部署 `worker/` 目录下的独立 Cloudflare Worker，在阅读器「设置 → 翻译代理」填入其地址即可生效。

## 项目结构

```
.
├── index.html            # 入口页面
├── css/style.css         # 样式
├── js/
│   ├── app.js            # 主控逻辑
│   ├── db.js             # IndexedDB 存储 + 阅读统计
│   ├── services.js       # 翻译 / 查词服务
│   ├── interaction.js    # 取词 / 划选交互
│   └── readers/          # txt.js / epub.js / pdf.js 三种阅读器
├── vendor/               # epub.min.js / pdf.min.js / jszip.min.js
├── functions/api/        # Cloudflare Pages 翻译代理
├── worker/               # 独立 Cloudflare Worker 翻译代理（可选）
├── samples/              # 测试样本（TXT / EPUB / PDF）
├── tools/                # 回归测试 / 功能测试 / 本地服务器
├── sw.js                 # Service Worker（离线缓存 + 版本守卫）
└── manifest.json         # PWA manifest
```

## 隐私

- 所有书籍、笔记、生词本、阅读设置**只存在于你自己的浏览器**，不上传任何服务器。
- 翻译 / 查词仅调用公共 API；可自建代理以避免跨域与访问限额。

## 版本与诊断

当前版本 `2026-07-28.7`。若遇到按钮无响应等异常，可点书架上的「工具」按钮打开诊断面板，查看「前端版本」是否与最新版本一致（不一致即浏览器在跑旧缓存，硬刷新 Ctrl+Shift+R 即可）。

## 商业授权（兑换码 / 买断制）

本项目支持「兑换码」收费模式：未激活可试用 3 次打开书本，输入有效兑换码后解锁完整版（买断制，一次付费永久使用）。

### 安全模型

- 兑换码由服务端（Cloudflare Pages Function `functions/api/redeem.js`）校验，**无法在前端伪造**。
- 令牌用 **Ed25519** 签名：服务端持私钥，前端只内嵌公钥验签。即使拿不到私有仓库源码，也无法伪造能通过验签的令牌。
- 每个兑换码限绑定 3 台设备（KV 记录设备列表），防一码共享。

### 服务端配置（部署到 Cloudflare Pages 后）

1. 生成密钥对：`node tools/keys.js`，私钥写入 `worker/keys.private.txt`（已在 `.gitignore`，**切勿提交**），公钥打印出来已内嵌进 `js/license.js`。
2. Pages 后台创建 **KV 命名空间**，绑定变量名 `CODES`。
3. 设置环境变量 `REDEEM_PRIVATE_KEY` = 私钥文件内容（即 `worker/keys.private.txt` 的完整 JSON）。
4. 生成兑换码：`node tools/gen-codes.js 20`（配 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `KV_NAMESPACE_ID` 环境变量时直接写入 KV；否则生成 `codes.json` 用 `wrangler kv bulk put` 手动写入）。
5. 用户端：阅读器「设置 → 输入兑换码」填入 `ENRD-XXXX-XXXX` 即激活。

### 本地开发自测

本地 `tools/serve.js` 内置 `/api/redeem`（用真实私钥签名，仅本地用，不随 Pages 部署），可直接在浏览器走通激活流程。`node tools/license-test.js` 验证签名/验签；`node tools/activate-test.js` 跑完整激活 E2E（需先启动 serve.js）。

## 许可证

本项目为可商用产品。源码授权方式见仓库许可设置；付费功能通过兑换码激活。
