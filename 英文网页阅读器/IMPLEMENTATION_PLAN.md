# 英文原版书阅读器 — 实现方案

> 纯前端 SPA，零服务器成本，本地优先，体验对标微信读书

---

## 一、技术栈选型

| 层面 | 选型 | 理由 |
|------|------|------|
| 框架 | React 18 + TypeScript | 生态成熟，epub.js / pdf.js 都有良好 React 封装 |
| 构建工具 | Vite 5 | 秒级热更新，开箱即用 |
| 样式 | TailwindCSS 3 + CSS 变量 | 原子化 + 主题切换方便 |
| 状态管理 | Zustand | 轻量（3KB），比 Redux 简单 10 倍 |
| EPUB 解析 | epub.js (jszip) | 业界标准，支持目录/分页/文本选择 |
| PDF 解析 | pdfjs-dist | Mozilla 官方库，支持文本层提取 |
| TXT 解析 | 自定义分页器 | 纯文本按字符/段落分页，最简单 |
| 语音朗读 | Web Speech API (SpeechSynthesis) | 浏览器内置，零成本，支持 en-US/en-GB |
| 单词查词 | Free Dictionary API (dictionaryapi.dev) | 完全免费，无需 API Key，含音标/释义/音频 |
| 句子翻译 | DeepL API Free | 免费 500,000 字符/月，翻译质量最高 |
| 本地存储 | IndexedDB (Dexie.js) + localStorage | 书籍/生词/进度存 IndexedDB，设置存 localStorage |
| 部署 | Vercel / Netlify 免费托管 | 零成本，自动 HTTPS，全球 CDN |

**总月度成本：¥0**（个人使用完全免费）

---

## 二、核心功能模块设计

### 2.1 文件导入模块

```
用户拖拽/选择文件
  ├── .epub → epub.js 解析 → 渲染为 HTML 章节
  ├── .pdf  → pdf.js 解析 → 渲染为 Canvas + 文本层
  └── .txt  → FileReader → 按段落分页
```

**实现要点：**
- 拖拽上传区 + 文件选择按钮双入口
- 文件解析后存入 IndexedDB（支持离线阅读）
- 书架页面展示已导入书籍（封面 + 标题 + 进度）
- 支持删除/重新导入

### 2.2 阅读引擎模块

**单页/双页切换：**
- 单页模式：居中显示一页内容，适合手机/窄屏
- 双页模式：左右并排两页，适合平板/桌面，模拟实体书翻页感
- 双页模式下点击右半区翻下一页，左半区翻上一页

**分页策略：**
- EPUB：利用 epub.js 的 `rendition.display()` + 自定义分页计算
- PDF：原生按页渲染，每页一屏
- TXT：按容器高度 + 字体大小动态计算每页字符数

**翻页交互：**
- 键盘：←/→ 翻页，Space 下一页
- 鼠标：点击左/右区域翻页
- 触摸：左右滑动翻页（移动端）
- 翻页动画：CSS transform 平滑过渡（150ms）

### 2.3 单词交互模块（核心）

**单击单词 — 三种模式（用户可在设置中切换）：**

| 模式 | 行为 |
|------|------|
| 模式 1：只发音 | 单击单词 → Web Speech API 朗读该单词 |
| 模式 2：只显示释义 | 单击单词 → 弹出词典卡片（音标 + 词性 + 释义） |
| 模式 3：发音 + 释义 | 单击单词 → 同时朗读 + 弹出词典卡片 |

**双击单词 — 句子翻译：**
- 双击单词 → 自动选中该单词所在的完整句子
- 调用 DeepL API 翻译整句 → 弹出翻译卡片显示中英对照
- 句子边界检测：通过 `.` `!` `?` + 大写字母开头判断句子起止

**词典卡片设计：**
```
┌─────────────────────────────┐
│  serendipity  /ˌserənˈdɪpəti/ │
│  [n.] 意外发现美好事物的能力    │
│                               │
│  "Finding this cafe was pure  │
│   serendipity."               │
│                               │
│  🔊  ⭐ 加入生词本             │
└─────────────────────────────┘
```

**技术实现：**
- EPUB：epub.js 渲染的 HTML 内容，给每个单词包裹 `<span>` 并绑定事件
- PDF：利用 pdf.js 的文本层（TextLayer），在文本层上绑定事件
- TXT：自定义渲染时直接按单词分割并包裹 span
- 防抖处理：区分单击/双击（300ms 延迟判断）

### 2.4 主题系统

三种主题，对标微信读书：

| 主题 | 背景 | 文字 | 适用场景 |
|------|------|------|----------|
| 亮色 | `#FFFFFF` | `#1A1A1A` | 日间/明亮环境 |
| 护眼 | `#F5F0E1` | `#5B4636` | 长时间阅读/暖光环境 |
| 暗色 | `#1A1A1A` | `#C8C8C8` | 夜间/暗光环境 |

- 通过 CSS 变量实现主题切换，零延迟
- 记住用户上次选择的主题
- 可选：跟随系统暗色模式

### 2.5 字体与排版

- 字体：英文用 serif（Georgia / Charter）提升阅读体验，UI 用 sans-serif
- 字号：14px - 24px 可调，5 档
- 行高：1.6 - 2.0 可调
- 页边距：可调
- 段落间距：可调

---

## 三、补充功能建议（我帮你加的）

### 3.1 生词本
- 查词时一键加入生词本
- 生词本页面：列表展示所有查过的单词 + 释义 + 来源书名 + 查词时间
- 支持按字母排序 / 按时间排序
- 支持导出为 CSV / Anki 卡片格式（方便复习）

### 3.2 阅读进度记忆
- 自动保存阅读位置（每翻一页存一次）
- 重新打开书籍时恢复到上次位置
- 书架页显示每本书的阅读进度百分比

### 3.3 划线笔记
- 长按/拖选文本 → 弹出工具栏（划线/笔记/翻译/朗读）
- 划线内容高亮显示（黄色下划线）
- 笔记页面统一管理所有划线和笔记

### 3.4 阅读统计
- 今日阅读时长
- 连续阅读天数
- 总阅读时长
- 已查生词数
- 简洁的统计卡片，不打扰阅读

### 3.5 目录导航
- EPUB：解析 NCX/Nav 自动生成目录
- PDF：解析书签或按页码导航
- TXT：按章节标题（正则匹配 Chapter/第X章）生成目录

### 3.6 全文搜索
- 在当前书中搜索关键词
- 高亮显示匹配结果
- 跳转到匹配位置

### 3.7 快捷键支持
- `←` / `→`：翻页
- `Space`：下一页
- `Esc`：关闭弹窗
- `Ctrl/Cmd + F`：搜索

---

## 四、分阶段实现计划

### Phase 1：基础框架 + 文件导入（MVP 核心）
- [ ] 初始化 React + TypeScript + Vite 项目
- [ ] 配置 TailwindCSS + CSS 变量主题系统
- [ ] 搭建路由（书架页 / 阅读页 / 设置页 / 生词本页）
- [ ] 实现文件上传组件（拖拽 + 选择）
- [ ] TXT 解析 + 基础分页阅读
- [ ] 三种主题切换

### Phase 2：EPUB + PDF 支持
- [ ] 集成 epub.js，实现 EPUB 解析与渲染
- [ ] 集成 pdf.js，实现 PDF 渲染 + 文本层
- [ ] 单页/双页模式切换
- [ ] 翻页交互（键盘/鼠标/触摸）
- [ ] 目录导航
- [ ] 阅读进度记忆

### Phase 3：单词交互核心
- [ ] 单词包裹 span + 事件绑定
- [ ] 单击三种模式实现
- [ ] 双击句子翻译
- [ ] Web Speech API 朗读
- [ ] Free Dictionary API 查词
- [ ] DeepL API 句子翻译
- [ ] 词典卡片 / 翻译卡片 UI

### Phase 4：进阶功能
- [ ] 生词本（增删查 + 导出）
- [ ] 划线笔记
- [ ] 阅读统计
- [ ] 全文搜索
- [ ] 字体/行距/边距调节
- [ ] 快捷键

### Phase 5：打磨与部署
- [ ] 移动端适配（响应式布局）
- [ ] PWA 支持（可离线使用、可安装到桌面）
- [ ] 性能优化（虚拟滚动、懒加载）
- [ ] 部署到 Vercel/Netlify

---

## 五、项目目录结构

```
english-reader/
├── public/
│   └── icons/
├── src/
│   ├── components/          # 通用组件
│   │   ├── FileUpload/
│   │   ├── BookCard/
│   │   ├── WordPopup/       # 词典卡片
│   │   ├── SentencePopup/   # 翻译卡片
│   │   └── Toolbar/         # 阅读工具栏
│   ├── readers/             # 阅读引擎
│   │   ├── EpubReader/
│   │   ├── PdfReader/
│   │   ├── TxtReader/
│   │   └── types.ts         # 统一阅读器接口
│   ├── pages/               # 页面
│   │   ├── BookShelf/       # 书架
│   │   ├── Reader/          # 阅读页
│   │   ├── Settings/        # 设置
│   │   ├── Vocabulary/      # 生词本
│   │   └── Notes/           # 笔记
│   ├── services/            # 核心服务
│   │   ├── tts.ts           # 语音朗读
│   │   ├── dictionary.ts    # 词典 API
│   │   ├── translation.ts   # 翻译 API
│   │   └── storage.ts       # IndexedDB 封装
│   ├── stores/              # Zustand 状态
│   │   ├── readerStore.ts
│   │   ├── settingsStore.ts
│   │   └── vocabularyStore.ts
│   ├── hooks/               # 自定义 Hooks
│   ├── styles/              # 全局样式 + 主题变量
│   │   ├── themes.css
│   │   └── globals.css
│   ├── types/               # TypeScript 类型
│   ├── utils/               # 工具函数
│   ├── App.tsx
│   └── main.tsx
├── index.html
├── package.json
├── tailwind.config.js
├── tsconfig.json
└── vite.config.ts
```

---

## 六、统一阅读器接口设计

为了让 EPUB / PDF / TXT 三种格式共用同一套交互逻辑，设计统一接口：

```typescript
interface IReader {
  // 生命周期
  init(container: HTMLElement, book: BookData): Promise<void>;
  destroy(): void;

  // 分页
  nextPage(): void;
  prevPage(): void;
  goToPage(page: number): void;
  getCurrentPage(): number;
  getTotalPages(): number;

  // 文本交互
  getSelectedText(): string;
  onWordClick(callback: (word: string, event: MouseEvent) => void): void;
  onWordDoubleClick(callback: (sentence: string, event: MouseEvent) => void): void;

  // 目录
  getTableOfContents(): TOCItem[];

  // 进度
  getProgress(): number;  // 0-1
  restoreProgress(progress: number): void;
}
```

每种格式实现这个接口，上层 UI 组件只依赖接口，不关心底层格式。

---

## 七、API 成本与限额

| 服务 | 免费额度 | 是否需要 Key | 备注 |
|------|----------|-------------|------|
| Free Dictionary API | 无限 | 不需要 | 单词查词，含音标/释义/例句 |
| DeepL API Free | 500,000 字符/月 | 需要（免费注册） | 句子翻译，质量最高 |
| Web Speech API | 无限 | 不需要 | 浏览器内置 TTS |
| Vercel/Netlify 托管 | 100GB 带宽/月 | 不需要 | 静态站点免费托管 |

> DeepL 免费版备选方案：如果用量超限，可切换到 MyMemory API（每日 5,000 词免费）或 Google Translate（需付费）。

---

## 八、UI 设计参考

整体风格参考微信读书：
- 书架：网格布局，书籍封面 + 标题，简洁卡片
- 阅读页：沉浸式，顶部/底部工具栏可隐藏（点击中间区域切换显示）
- 设置面板：从底部/侧边滑出，半透明遮罩
- 词典卡片：浮动在单词上方，带小箭头指向
- 翻译卡片：底部弹出，中英对照
- 整体留白充足，字号偏大，行距宽松

色彩规范：
- 主色：`#3B82F6`（蓝色，用于按钮/链接/选中态）
- 亮色主题：白底黑字
- 护眼主题：米黄底深棕字
- 暗色主题：深灰底浅灰字

---

## 九、关键难点与解决方案

| 难点 | 解决方案 |
|------|----------|
| EPUB 单词事件绑定 | epub.js 渲染后遍历 DOM，将文本节点按单词拆分包裹 span |
| PDF 文本选择 | 使用 pdf.js TextLayer，在 Canvas 上叠加透明文本层 |
| 单击/双击区分 | 300ms 延迟：单击后 setTimeout，若 300ms 内再次点击则取消单击，触发双击 |
| 大文件性能 | EPUB 按章节懒加载；PDF 按页虚拟滚动；TXT 分块加载 |
| 离线使用 | PWA + Service Worker 缓存所有静态资源 |
| DeepL API 跨域 | DeepL 免费版需通过后端代理（Vercel Serverless Function 免费部署） |
| 句子边界检测 | 正则匹配句末标点 + 下一个单词首字母大写 |

---

## 十、总结

| 维度 | 方案 |
|------|------|
| 成本 | ¥0/月（全部免费服务） |
| 技术栈 | React + TypeScript + Vite + TailwindCSS |
| 核心库 | epub.js + pdf.js + Web Speech API |
| 翻译 | DeepL Free + Free Dictionary API |
| 存储 | IndexedDB + localStorage（纯本地） |
| 部署 | Vercel/Netlify 免费托管 |
| 开发周期 | Phase 1-3 为 MVP（核心可用），Phase 4-5 为完善 |

**核心优势：**
1. 纯前端，零服务器成本
2. 本地优先，数据全部存在浏览器，隐私安全
3. 体验对标微信读书，简洁大方
4. PWA 支持，可安装到桌面/手机，可离线使用
5. 可扩展性强，统一阅读器接口方便后续添加更多格式
