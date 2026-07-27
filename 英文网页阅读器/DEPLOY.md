# 部署指南（让别人也能用）

目标：把阅读器发布到公网，任何人、任何设备打开链接即可使用，无需安装、无需各自配置翻译。

已内置的能力（部署后自动生效）：
- `functions/api/translate.js`：Cloudflare Pages 函数，提供同源翻译代理 `/api/translate`。
  所有访客默认走它，无需自建代理、无 CORS 问题、免费。
- 书籍存在**每个访客自己的浏览器**（IndexedDB），互不影响、不上传，天然多用户。
- 翻译链路兜底：`/api/translate` → Lingva → MyMemory；某条挂了自动切换。

---

## 方式 A：Cloudflare Pages 仪表盘（推荐，零安装）

1. 打开 https://dash.cloudflare.com/ 并登录。
2. 左侧 **Workers 和 Pages** → **创建** → **Pages** → **上传资产(Upload assets)**。
3. 把本项目目录拖进去（或选目录）。
   - 会自动忽略 `.workbuddy/`、`tools/`、`worker/`、`*.bat`（见 `.gitignore`）。
   - 保留 `index.html`、`js/`、`css/`、`functions/` 等。
4. 构建命令留空，输出目录留空（纯静态）。
5. 点 **部署**。完成后得到 `https://<项目名>.pages.dev` 这样的公网地址。
6. 把这个地址发给任何人即可。打开即用，翻译默认可用。

> 想用自己域名：Pages 项目里 **自定义域** 绑一个已托管在 Cloudflare 的域名即可。

---

## 方式 B：一键部署脚本（需装 Node.js）

适合命令行党。已备好 `pages-deploy.bat`（纯英文、防乱码，含 Node 自检）：

1. 装 Node.js LTS：https://nodejs.org ，一路下一步，装完重开终端输入 `node -v` 验证。
2. 双击本项目里的 `pages-deploy.bat`。
3. 按提示在浏览器里授权 Cloudflare（Allow）。
4. 自动部署，终端打印 `*.pages.dev` 公网地址。

本质就是执行：
```
npx wrangler login
npx wrangler pages deploy . --project-name en-reader
```

---

## 关于独立的翻译 Worker（`worker/` 目录）

如果你的 Cloudflare 账号对 Pages Functions 有地域/配额限制，也可以用独立 Worker 作翻译代理：
1. 仪表盘 **Workers** → 新建 Worker，把 `worker/index.js` 内容粘进去 → Deploy。
2. 复制 `*.workers.dev` 地址。
3. 在阅读器 **设置 → 翻译代理** 填入该地址 → 点「测试」变绿即生效。

部署态的 `/api/translate` 优先级低于「设置里填写的自建代理」，所以两种方式可并存：默认用内置、想更快可填自己的 Worker。

---

## 验证部署成功

- 打开 `*.pages.dev`，导入一本英文书，单击单词应出中文释义，双击句子应出中文译文。
- 无需任何设置，翻译即可用（走内置 `/api/translate`）。
