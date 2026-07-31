# 英文原版书阅读器 (English E-book Reader)

隐私优先的英文原版书阅读器，对标微信读书的学英语体验。支持 TXT / EPUB / PDF 三格式，单击查词、双击整句翻译、书内全文搜索、排版设置、离线可用。默认情况下书籍与学习数据只存在你自己的浏览器里。

## 快速开始

需通过静态服务器访问（不能直接 `file://` 打开，Service Worker 要求 http(s) 环境）：

```bash
node tools/serve.js        # 推荐：自带 no-cache 头，浏览器打开 http://localhost:9000
# 或：npx serve .          python3 -m http.server 9000
```

首次运行自动化测试：

```bash
npm install
npx playwright install chromium
npm test
```

导入 TXT / EPUB / PDF 即可阅读；点书架「📚 书城」可从 Project Gutenberg 搜索并一键下载公版英文书。

## 主要功能

- **三格式阅读**：TXT 多列分页 / EPUB（epub.js）/ PDF（pdf.js）
- **单击查词**：Free Dictionary 释义 + 音标 + 真人发音（Web Speech API）
- **双击整句翻译**：默认 MyMemory / Lingva，可配自建 Cloudflare Worker 代理
- **书内全文搜索**：Ctrl/F 唤起，结果高亮跳转（上限 200 条）
- **排版设置**：行距 + 版心宽度；明暗主题；阅读统计
- **古腾堡书城**：内置公版书目录，一键下载入库（数据仍只存本地）
- **离线可用**：Service Worker + 版本守卫自动清理旧缓存

## 激活（兑换码）

未激活可试用 3 次打开书本。在「设置 → 输入兑换码」填入 `ENRD-XXXX-XXXX` 即解锁买断制完整版（一次付费永久使用）。

- **本地自测**：`node tools/serve.js` 内置 `/api/redeem`（用真实私钥签名），可直接用测试码 **`ENRD-ABCD-1234`** 走通激活流程。
- **线上部署**：Cloudflare Pages 的 `/api/redeem` 走 KV 校验，需先配置 KV 命名空间（变量名 `CODES`）+ 环境变量 `REDEEM_PRIVATE_KEY`（= `worker/keys.private.txt` 内容），再用 `node tools/gen-codes.js` 生成兑换码。详见 `functions/api/redeem.js` 注释。

## 部署

纯静态站点，可托管任意平台（Cloudflare Pages / GitHub Pages / 任意静态服务器）。Cloudflare Pages 已内置 `functions/api/` 提供翻译与古腾堡同源代理，开箱即用。

## 项目结构

```
index.html            入口页面
css/style.css         样式
js/                   app.js(主控) db.js(存储) services.js(翻译查词) interaction.js(取词)
                      gutenberg.js(书城) readers/(txt/epub/pdf) license.js(授权)
vendor/               epub.js / pdf.js / jszip
functions/api/        Cloudflare Pages：翻译 / 兑换 / 古腾堡代理
worker/               独立翻译 Worker（可选）
samples/ tools/       测试样本 / 回归与本地服务器
sw.js manifest.json   Service Worker 离线壳 / PWA
```

## 隐私

默认情况下，书籍、书签、生词和设置只存在于你的浏览器。翻译 / 查词会把所选文本发送给公共 API 或你配置的代理。

只有主动设置跨设备同步密钥后，书籍文件、书架元数据、生词和阅读进度才会上传到部署者配置的 Cloudflare KV。同步密钥至少 16 位，通过请求头发送；服务端只以其 SHA-256 哈希作为存储键。同步内容目前未做端到端加密，因此不应在不受信任的部署上启用。

---

当前版本 `2026-07-30.52`。若遇按钮无响应，点书架「工具」看前端版本是否一致；不一致即浏览器在跑旧缓存，硬刷新 Ctrl+Shift+R 即可。
