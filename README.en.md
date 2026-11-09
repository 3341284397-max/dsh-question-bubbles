# Question Bubbles

**English** | [简体中文](./README.md)

> Watch the questions your model almost asks — without interrupting it.

During reasoning, a model often gets stuck on an ambiguity it never voices. This plugin surfaces those almost-questions as bubbles floating above the whale widget. You can answer one in place if you happen to catch it; the answer is queued with `steer` and folded in at the next step boundary. The model is never interrupted.

A bundle for [DeepSeek Harness](https://github.com/deepseek-ai) desktop. The host side subscribes to the live reasoning stream (`reasoning-delta` frames of `agent/assistant-stream`) and extracts question-like sentences; a small injected script renders them as bubbles.

- **Non-intrusive** — bubbles are a side channel; nothing is added to the conversation context.
- **Not persisted** — questions live in memory only. Restart DSH and they're gone, by design: the value is being *caught in the moment*.
- **Answer in place** — type one line into a bubble, it queues for the next step.
- **Two capture paths** — an opt-in prompt-marker protocol (the model labels its own questions) plus regex fallback.
- **Multi-language** — 中文 / English / 日本語 / 한국어 / Русский, with `auto` following the language the model is actually thinking in.
- **Theme follows DSH** — dark / light / system, matching the host.

---

## Requirements

- **DeepSeek Harness desktop** — this is a DSH bundle, not a standalone app.
- **Balance Whale Widget** — [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget). Bubbles anchor above the whale and the panel opens with a middle-click on it. Without the widget only the corner 💭 knob works and bubbles have no anchor.

---

## Install

Local bundle, no build step:

1. Put the folder under your profile:

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

3. Restart DSH. The host half is read at startup only; the client script hot-reloads on refresh.

The bundle self-declares via `package.json` → `dsh.bundle.patch` → `cordis.patch.yml`.

---

## Use

- **Middle-click the whale** (or the 💭 knob) → panel: master switch, max bubbles (1–9), language mode, theme, three counters (seen / answered / moved on).
- **Click a bubble** → inline input → Send (`steer`) or Skip. Right-click to expand the full text; the × dismisses it.
- **30 s** without attention and a bubble fades out; answered ones stay lit until the next step.

Config lives at `<DSH_HOME>/dsh-question-bubbles/config.json`:

```json
{ "enabled": true, "maxBubbles": 9, "langMode": "auto", "markers": true }
```

---

## Two capture paths

### 1. Prompt-marker protocol (on by default, `markers: true`)

The plugin adds a short section (~120 tokens, nearly free once cached) to the system prompt asking the model to write, while thinking:

```
⟦问⟧a short question (≤30 汉字 or ≤12 words)⟦/问⟧
...
⟦答⟧one-line resolution⟦/答⟧
```

- Bubbles from a marker carry a ✦ badge — they're the model's own labels, not regex guesses.
- If the model later writes `⟦答⟧`, that bubble turns into “resolved itself” and collapses.
- The protocol is explicit about restraint: only real blocking ambiguity, never rhetorical self-checks, at most 3 per step, and if nobody answers, decide and continue.

### 2. Regex fallback (when the model doesn't mark)

- a sentence ending in `？` / `?`; or
- a sentence with hesitation markers (`unsure / whether / should I / 不确定 / 拿不准 / 要不要 / 该不该 …`) that doesn't look like a quote of the user.

Then per-language length/word-count filters, balanced-quote checks, and skipping code fences (` ``` `), paths, URLs and key-value fragments. Near-duplicates are merged by normalized text + bigram Jaccard similarity; throttled to 6 per step and 20 per minute.

When the model starts writing prose or calls a tool, unanswered questions are marked **moved on** (dimmed, still answerable).

---

## Language modes

| value | meaning |
| --- | --- |
| `auto` | only questions in the language the current reasoning is written in (default) |
| `all` | accept any supported language |
| `zh` / `en` / `ja` / `ko` / `ru` | lock to one language (Traditional Chinese counts as `zh`) |

Panel labels follow the browser language (`zh` / `en` / `ja` / `ko` / `ru`, English fallback).

---

## HTTP surface

| route | purpose |
| --- | --- |
| `GET /dsh-qb/client.js` | client script (cached by mtime — refresh after edits) |
| `GET /dsh-qb/events` | SSE, event `msg`: `hello` / `q` / `resolve` / `config` / `counters` |
| `GET /dsh-qb/state` | config + counters + recent questions (`sse` = live page connections) |
| `POST /dsh-qb/config` | `{ enabled?, maxBubbles?, langMode?, markers? }` |
| `POST /dsh-qb/answer` | `{ id, text }` → `sessionController.prompt(mode: 'steer')` |
| `GET /dsh-qb/demo?text=…` | push a fake question, for checking the renderer |

All routes are gated to loopback `Host` values, reject `Sec-Fetch-Site: cross-site`, and require a same-origin `Origin` when one is present.

---

## Tests

```powershell
node test/host.test.mjs
```

Runs the whole host path with a fake root/ctx (no DSH needed): injection row → reasoning extraction → SSE → `/state` → `/answer` (steer) → `/demo` → trust fence → multi-language → marker protocol (split-across-deltas and self-resolve).

---

## Known limits

- Regex extraction will both miss and over-report; the marker protocol helps a lot but relies on the model following the convention.
- Answers only land at the next step boundary — that's the point, but a late answer may arrive after the step it would have helped.
- Models that don't stream `reasoning` produce no bubbles.
- One SSE stream is shared by all agents/subagents; bubbles aren't attributed to a source session yet.
- Positioning requires the whale widget; without it only the corner knob is available.

---

## License

MIT © 2026 Lyrins

## Credits

Bubble positioning, the whale anchor and the panel entry point are built around [Balance Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) by MeteorNOX. This project only reads its DOM (`.dshwv-root`) and listens for a middle-click; it does not modify the widget.
