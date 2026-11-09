# Question Bubbles · 问题泡泡

> Watch the questions your model almost asks — without interrupting it.
> 在模型思考的过程中，把它「正在纠结、但最终可能没问出口」的疑问，以气泡浮在鲸鱼挂件上方。

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai) desktop. The host side subscribes to the agent's live reasoning stream and extracts question-like sentences; a small injected script renders them as bubbles floating above the whale widget. If you happen to catch one you can answer, click it and your answer is folded into the session with `steer` (queued for the next step boundary) — the model is never interrupted.

- **Non-intrusive** — the model doesn't know it's being watched. Bubbles are parsed on the host from the reasoning stream, nothing is injected into the prompt.
- **Not persisted** — questions live in memory only; restart DSH and they're gone.
- **Answer in place** — type one line into a bubble, it goes into the queue (`steer`) at the next step boundary.
- **Graceful without the whale** — if the whale widget isn't installed, a small 💭 knob in the corner opens the panel instead.
- **Multi-language** — 中文 / English / 日本語 / 한국어 / Русский, with an auto mode that follows the language the model is actually thinking in.

---

## Requirements · 前置依赖

- **DeepSeek Harness desktop** — this is a DSH bundle, not a standalone app.
- **Balance Whale Widget** — [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget). Currently the UI depends on it: bubbles anchor above the whale, and the panel opens with a middle-click on the whale. Without it only the corner 💭 knob works, and bubbles have no anchor to float over.

---

## Install · 安装

This is a local DSH bundle (no build step). Three steps:

1. Put the folder under your DSH profile:

   ```
   <DSH_HOME>/profiles/desktop/node_modules/dsh-question-bubbles
   ```

   A junction / symlink to a checkout works too.

2. Register it in `<DSH_HOME>/profiles/desktop/package.json`:

   ```json
   {
     "dsh": { "profile": { "bundles": [ "...", "dsh-question-bubbles" ] } },
     "dependencies": { "dsh-question-bubbles": "link:<absolute path to the folder>" }
   }
   ```

3. Restart DSH. The host half is only read at startup; the client script hot-reloads on refresh.

The bundle self-declares via `package.json` → `dsh.bundle.patch` → `cordis.patch.yml`.

---

## Use · 用法

- **Middle-click the whale** (or the 💭 knob) → panel: master switch, max bubbles (1–9), language mode, three counters (seen / answered / moved on).
- **Click a bubble** → inline input → Send (`steer`) or Skip. Right-click a bubble to expand the full text. The × on a bubble dismisses it.
- **30 s** without attention and a bubble fades out; bubbles you answered stay lit until the next step.

Config lives at `<DSH_HOME>/dsh-question-bubbles/config.json`:

```json
{ "enabled": true, "maxBubbles": 9, "langMode": "auto" }
```

### Language modes · 语言模式

| value | meaning |
| --- | --- |
| `auto` | only questions in the language the current reasoning is written in (default) |
| `all` | accept any supported language |
| `zh` / `en` / `ja` / `ko` / `ru` | lock to one language (Traditional Chinese counts as `zh`) |

The panel labels follow the browser language (`zh` / `en` / `ja` / `ko` / `ru`, English fallback).

---

## How it decides "this is a question" · 怎么判断

Pure heuristics, no prompt changes:

- a sentence ending in `？` / `?`; or
- a sentence containing hesitation markers (`不确定 / 拿不准 / 要不要 / 该不该 / 是否应该 / 需要确认 / unsure / whether / should I …`) that doesn't look like a quote of the user.

Then, per language: minimum character/word counts, at least 3 CJK characters for Chinese, no unbalanced quotes, no code-block content (fenced with ` ``` `), no paths/URLs/key-value fragments. Duplicates are merged by normalized text + bigram Jaccard similarity. Throttled to 6 per attempt and 20 per minute.

When the model starts writing prose or calls a tool, its unanswered questions are marked **moved on** (dimmed but still answerable).

---

## HTTP surface · 接口

| route | purpose |
| --- | --- |
| `GET /dsh-qb/client.js` | client script (cached by mtime — refresh the page after edits) |
| `GET /dsh-qb/events` | SSE, event `msg`: `hello` / `q` / `resolve` / `config` / `counters` |
| `GET /dsh-qb/state` | config + counters + recent questions (also `sse` = live page connections) |
| `POST /dsh-qb/config` | `{ enabled?, maxBubbles?, langMode? }` |
| `POST /dsh-qb/answer` | `{ id, text }` → `sessionController.prompt(mode: 'steer')` |
| `GET /dsh-qb/demo?text=…` | push a fake question, for checking the renderer |

All routes are gated to loopback `Host` values, reject `Sec-Fetch-Site: cross-site`, and require a same-origin `Origin` when one is present.

---

## Tests · 自测

```powershell
node test/host.test.mjs
```

Runs the whole host path with a fake root/ctx (no DSH needed): injection row → reasoning extraction → SSE → `/state` → `/answer` (steer) → `/demo` → trust fence → multi-language cases. All assertions must pass.

---

## Known limits · 已知限制

- Heuristic extraction will both miss and over-report. The prompt-marker protocol (letting the model label its own open questions) is a planned v1.
- Answers only land at the next step boundary — that's the point, but it means a late answer may arrive after the step it would have helped.
- Models that don't stream `reasoning` produce no bubbles.
- One SSE stream is shared by all agents/subagents; bubbles aren't attributed to a source session yet.
- Requires the whale widget for positioning; without it you get the corner knob (no bubble stack anchor).

---

## License

MIT © 2026 Lyrins

## Credits · 致谢

Bubble positioning, the whale anchor and the panel entry point are built around [Balance Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) by MeteorNOX. This project only reads its DOM (`.dshwv-root`) and listens for a middle-click; it does not modify the widget.
