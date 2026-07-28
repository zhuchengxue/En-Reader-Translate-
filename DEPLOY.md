# 部署指南（让别人也能用）

目标：把阅读器发布到公网，任何人、任何设备打开链接即可使用，无需安装、无需各自配置翻译。

已内置的能力（部署后自动生效）：
- `functions/api/translate.js`：Cloudflare Pages 函数，提供同源翻译代理 `/api/translate`。
  所有访客默认走它，无需自建代理、无 CORS 问题、免费。
- 书籍存在**每个访客自己的浏览器**（IndexedDB），互不影响、不上传，天然多用户。
- 翻译链路兜底：`/api/translate` → Lingva → MyMemory；某条挂了自动切换。

> ⚠️ 当前 GitHub 仓库根目录即应用根（`index.html` / `js` / `css` / `functions` … 同处根目录）。
> 下面两种方式的根目录都填仓库根（`/`），构建命令与输出目录留空。

---

## 方式一：连接 GitHub 仓库（推荐，自动部署）

你已经把代码传到了 GitHub，且之前登录过 Cloudflare，所以这条路最顺，而且**以后每次 push 自动重新部署**。

1. 打开 https://dash.cloudflare.com/ 并登录（用你之前那个账号）。
2. 左侧 **Workers 和 Pages** → **创建** → **Pages** → **连接到 Git（Connect to Git）**。
3. 首次会要求授权 GitHub，点 **Authorize Cloudflare** 允许。
4. 在仓库列表里选 **En-Reader-Translate-**（你刚建的仓库）。
5. 配置构建：
   - 项目名：随便填，例如 `en-reader`。
   - 生产分支：**main**。
   - 框架预设：**None**（纯静态）。
   - 构建命令：**留空**。
   - 构建输出目录：**留空**。
   - **根目录（Root directory，点开“高级”才看得到）：填 `英文网页阅读器`** ← 关键，因为代码在这个子目录里。
6. 点 **保存并部署（Save and Deploy）**。
7. 一两分钟后得到公网地址：`https://en-reader.pages.dev`（名字按你填的项目名）。
8. 把这个地址发给任何人即可——打开即用，翻译默认可用。
9. 以后你改了代码 `git push` 到 main，Cloudflare 会自动重新部署，无需再操作。

---

## 方式二：仪表盘上传资产（零安装，不连 Git）

如果你不想连 Git，也可以手动上传：

1. 打开 https://dash.cloudflare.com/ → **Workers 和 Pages** → **创建** → **Pages** → **上传资产（Upload assets）**。
2. 这一步要拖**文件夹里面的内容**，不要拖 `英文网页阅读器` 这个文件夹本身
   （否则会再套一层目录，导致 `index.html` 不在根）。
   即：打开 `英文网页阅读器` 文件夹，把里面的 `index.html`、`js/`、`css/`、`functions/` 等一起选中拖进去。
   - 会自动忽略 `.workbuddy/`、`tools/`、`worker/`、`*.bat`（见 `.gitignore`）。
3. 构建命令留空，输出目录留空（纯静态）。
4. 点 **部署**。完成后得到 `https://<项目名>.pages.dev`。

---

## 方式三：一键部署脚本（需装 Node.js）

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
（注意要在 `英文网页阅读器` 目录下运行，确保 `functions/` 在同目录。）

---

## 关于独立的翻译 Worker（`worker/` 目录）

如果你的 Cloudflare 账号对 Pages Functions 有地域/配额限制，也可以用独立 Worker 作翻译代理：
1. 仪表盘 **Workers** → 新建 Worker，把 `worker/index.js` 内容粘进去 → Deploy。
2. 复制 `*.workers.dev` 地址。
3. 在阅读器 **设置 → 翻译代理** 填入该地址 → 点「测试」变绿即生效。

部署态的 `/api/translate` 优先级低于「设置里填写的自建代理」，所以两种方式可并存：默认用内置、想更快可填自己的 Worker。

---

## 兑换码授权（收费模式，可选）

若要把本项目作为收费产品（买断制兑换码），需在 Cloudflare 侧配置校验后端：

1. **生成密钥**：`node tools/keys.js` → 私钥写入 `worker/keys.private.txt`（已在 `.gitignore`，切勿提交），公钥已内嵌 `js/license.js`。
2. **KV 命名空间**：Pages 后台建 KV 命名空间，绑定变量名 `CODES`。
3. **环境变量**：设置 `REDEEM_PRIVATE_KEY` = 私钥文件完整 JSON。
4. **兑换码**：`node tools/gen-codes.js 20`（配 `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID`/`KV_NAMESPACE_ID` 直写 KV，否则生成 `codes.json` 用 `wrangler kv bulk put` 写入）。
5. 用户端「设置 → 输入兑换码」填入 `ENRD-XXXX-XXXX` 即激活；未激活可试用 3 次打开书本。

> 本地 `tools/serve.js` 内置 `/api/redeem`（用真实私钥签名，仅本地开发，不随 Pages 部署），可先在浏览器走通激活流程再上生产。

---

## 验证部署成功

- 打开 `*.pages.dev`，导入一本英文书，单击单词应出中文释义，双击句子应出中文译文。
- 无需任何设置，翻译即可用（走内置 `/api/translate`）。
- 用手机或其他电脑打开同一个链接也能用，互不干扰。
