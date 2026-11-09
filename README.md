# Question Bubbles · 问题泡泡

[English](./README.en.md) | **简体中文**

> 在模型思考的过程中，把它「正在纠结、但最终可能没问出口」的疑问，以气泡浮在鲸鱼挂件上方。
> 不打断任务；你恰好看到、恰好能答，就顺手回一句。

这是 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面端的一个插件（DSH bundle）。Host 侧订阅模型的实时思考流（`agent/assistant-stream` 的 `reasoning-delta`），把疑问抽出来；一小段注入脚本把它们画成气泡。作答通过 `steer` 排队，在下一个 step 边界并入会话——模型不会被打断。

- **不打断** —— 气泡只是旁路显示，不进入对话上下文。
- **不落盘** —— 疑问只存在内存里，重启 DSH 就没了（这是刻意的：它的价值是"被恰好看见"）。
- **就地作答** —— 点气泡，一行字，排队到下一轮。
- **两种捕获** —— 提示词标记协议（模型自己标）+ 正则兜底（没标也能捞）。
- **多语种** —— 中文 / English / 日本語 / 한국어 / Русский，`auto` 会跟随模型此刻实际在用的语言。
- **主题跟随 DSH** —— 深色 / 浅色 / 跟随系统，与宿主保持一致。

---

## 前置依赖

- **DeepSeek Harness 桌面端** —— 这是 DSH 的 bundle，不是独立应用。
- **Balance Whale Widget** —— [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。气泡靠它定位（浮在鲸鱼上方），面板靠中键点它打开。没装的话只剩右下角 💭 圆点可用，气泡没有锚点。

---

## 安装

纯本地 bundle，无构建步骤：

1. 把目录放到 profile 下：

   ```
   <DSH_HOME>/profiles/desktop/node_modules/dsh-question-bubbles
   ```

   用 junction / 软链接指向源码目录也可以。

2. 在 `<DSH_HOME>/profiles/desktop/package.json` 里登记：

   ```json
   {
     "dsh": { "profile": { "bundles": [ "...", "dsh-question-bubbles" ] } },
     "dependencies": { "dsh-question-bubbles": "link:<该目录的绝对路径>" }
   }
   ```

3. 重启 DSH。Host 半只在启动时读取；客户端脚本刷新页面即可热更新。

bundle 通过 `package.json` → `dsh.bundle.patch` → `cordis.patch.yml` 自我声明。

---

## 用法

- **中键点鲸鱼**（或右下角 💭）→ 面板：总开关、气泡数量上限（1–9）、语言模式、主题、三个计数器（出现 / 你答了 / 自己往下走了）。
- **点气泡** → 就地输入 → 「发过去」（`steer`）或「算了」。右键气泡展开全文；气泡右上角的 × 手动关掉。
- **30 秒**没人搭理就淡出；你答过的会亮着留到下一轮。

配置在 `<DSH_HOME>/dsh-question-bubbles/config.json`：

```json
{ "enabled": true, "maxBubbles": 9, "langMode": "auto", "markers": true }
```

---

## 两种捕获方式

### 1. 提示词标记协议（默认开启，`markers: true`）

插件会往 system prompt 挂一小段约定（约 120 tokens，命中缓存后几乎免费），让模型在思考里主动写：

```
⟦问⟧一句很短的问题（≤30 汉字或 ≤12 词）⟦/问⟧
...
⟦答⟧自己解决后的结论⟦/答⟧
```

- 带 `⟦问⟧` 的气泡显示一个 ✦，表示"这是模型自己标出来的"，不是正则猜的。
- 模型后来写了 `⟦答⟧`，那条气泡会转成「已自解」并快速收起。
- 协议里写死了使用条件：只在真的卡住、需要用户拍板时用；不要修辞性自问；每步最多 3 条；没人回答就自己决定并继续。

### 2. 正则兜底（模型没标时）

- 以 `？` / `?` 结尾的句子；或
- 含犹豫词（`不确定 / 拿不准 / 要不要 / 该不该 / 是否应该 / 需要确认 / unsure / whether / should I …`）且不像在复述用户原话的句子。

再按语言做长度/字数/引号配平过滤，跳过代码块（` ``` `）、路径、URL、键值片段；同义句子按归一化文本 + 二元组 Jaccard 合并；节流为单步最多 6 条、每分钟 20 条。

模型开始写正文或调工具时，还没答的疑问标成 **已自行推进**（变暗，但仍可回答）。

---

## 语言模式

| 值 | 含义 |
| --- | --- |
| `auto` | 只认当前思考所用语言的疑问（默认） |
| `all` | 任何支持语言都认 |
| `zh` / `en` / `ja` / `ko` / `ru` | 锁定一种语言（繁体中文算 `zh`） |

面板文案跟随浏览器语言（`zh` / `en` / `ja` / `ko` / `ru`，其余回落英文）。

---

## HTTP 接口

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-qb/client.js` | 客户端脚本（按 mtime 缓存，改完刷新页面） |
| `GET /dsh-qb/events` | SSE，event `msg`：`hello` / `q` / `resolve` / `config` / `counters` |
| `GET /dsh-qb/state` | 配置 + 计数器 + 最近疑问（`sse` = 当前页连接数） |
| `POST /dsh-qb/config` | `{ enabled?, maxBubbles?, langMode?, markers? }` |
| `POST /dsh-qb/answer` | `{ id, text }` → `sessionController.prompt(mode: 'steer')` |
| `GET /dsh-qb/demo?text=…` | 塞一条假疑问，用来验证渲染 |

所有路由只放行回环 `Host`，拒绝 `Sec-Fetch-Site: cross-site`，有 `Origin` 时要求同源。

---

## 自测

```powershell
node test/host.test.mjs
```

用假的 root/ctx 跑完整 Host 链路（不需要启动 DSH）：注入行 → 思考流抽句 → SSE → `/state` → `/answer`（steer）→ `/demo` → 信任栅栏 → 多语种 → 标记协议（跨 delta 拼接 / 自解）。

---

## 已知限制

- 正则兜底会漏也会多报；标记协议能显著改善，但依赖模型遵守约定。
- 答案只在下一个 step 边界落地——这是设计目的，但也意味着你回得太晚可能帮不上正在卡的那一步。
- 模型不流式输出 `reasoning` 时不会有气泡。
- 所有 agent 共用一条 SSE，气泡暂不区分来源会话。
- 定位依赖鲸鱼挂件；没有它只能用右下角圆点。

---

## License

MIT © 2026 Lyrins

## 致谢

气泡定位、鲸鱼锚点和面板入口围绕 MeteorNOX 的 [Balance Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 构建。本项目只读取它的 DOM（`.dshwv-root`）、只监听中键，不修改对方。
