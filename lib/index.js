/**
 * dsh-question-bubbles —— Host 半
 *
 * 职责：
 *   1. 订阅 agent/assistant-stream，实时拿到模型思维链增量（reasoning-delta）；
 *   2. 用启发式规则从思维链里捞出「模型正在纠结的疑问」；
 *   3. 通过本地 SSE 推给页面里的前端脚本，由它画成气泡；
 *   4. 接收气泡里的作答，用 sessionController.prompt(mode:'steer') 温和排队注入。
 *
 * 设计约束（P0）：
 *   - 不碰系统提示词，纯旁路观察；模型完全不知道被看着。
 *   - 不落盘：疑问只存在内存里，关掉就没了（用户明确要求"只为碰运气被看见"）。
 *   - 不改 whale-widget 源码，只借它画好的鲸鱼做定位锚点。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'dsh-question-bubbles')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

const CLIENT_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'question-bubbles.js'),
  path.join(HERE, 'question-bubbles.js'),
]

const ROUTE_PREFIX = '/dsh-qb'
const ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + ROUTE_PREFIX + '/client.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

const LANG_MODES = ['auto', 'all', 'zh', 'en', 'ja', 'ko', 'ru']

const DEFAULT_CONFIG = {
  enabled: true,
  maxBubbles: 9,
  // auto = 跟随这轮思考的语言；all = 不限；zh/en/ja/ko/ru = 只要这一种
  langMode: 'auto',
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    let mode = typeof raw.langMode === 'string' ? raw.langMode : null
    // 旧版本只有 allowEnglish 开关：true 等价于 auto
    if (!mode && raw.allowEnglish === true) mode = 'auto'
    return {
      enabled: raw.enabled !== false,
      maxBubbles: clamp(Math.round(Number(raw.maxBubbles) || 9), 1, 9),
      langMode: LANG_MODES.includes(mode) ? mode : 'auto',
    }
  } catch (err) {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(next) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n
}

/* ------------------------------------------------------------------ */
/* 疑问判定                                                            */
/* ------------------------------------------------------------------ */

const QMARK = /[？?]/
// 「纠结」气味词：模型不太确定、在自我盘问时常用
const SUSPECT =
  /(不确定|不清楚|不太确定|拿不准|说不好|需要确认|要不要|该不该|是不是该|是否应该|是否要|应该先|还是先|用什么|怎么问|还需确认|有待确认|需要问|得问|要不要问|不確定|該不該|是否應該|需要確認|拿不準|要不要問)/
// 复述用户原话的句子不是"疑问"
const QUOTED = /^(用户|对方|他说|她说|它说|你说|原文|上文).{0,6}(说|问|提到|要求|希望|表达|描述)/
// 常见口头起手，去掉以免气泡里满屏"那么，"
const STOP_PREFIX =
  /^(嗯+|呃+|哦+|好+[，,]|对[，,]|那么[，,]|所以[，,]|但是[，,]|不过[，,]|但[，,]|还有[，,]|另外[，,]|然后[，,]|总之[，,]|其实[，,]|首先[，,]|其次[，,])+/
const MD_PREFIX = /^[-*+>\s]*(?:\d+[.、)]\s*)?/
const WRAP_HEAD = /^["'`「『（(【\[]+/
const WRAP_TAIL = /["'`」』）)】\]]+$/

// 代码/路径/URL/键值对 —— 思维链里这类片段很多，不能当疑问
const CODEISH = /[`{}<>\\]|:\/\/|[\w.-]+\.[a-z]{2,4}\b|\/\w|=\S|\|\||\$\{|\.\.\.|\bconsole\.|\bfunction\b|=>/

/* ---------------- 多语种：先按文字系统判语言，再按语言判疑问 ---------------- */

const SCRIPT_RE = {
  han: /[\u3400-\u9fff]/g, // 汉字（简/繁）
  kana: /[\u3040-\u30ff]/g, // 平假名 + 片假名
  hangul: /[\uac00-\ud7af\u1100-\u11ff]/g, // 谚文
  cyr: /[\u0400-\u04ff]/g, // 西里尔
  lat: /[A-Za-z]/g, // 拉丁
}

function scriptCounts(s) {
  const t = String(s || '')
  const out = {}
  for (const k of Object.keys(SCRIPT_RE)) out[k] = (t.match(SCRIPT_RE[k]) || []).length
  return out
}

function cjkCount(s) {
  return scriptCounts(s).han
}

// 一句话属于哪种语言（只看文字系统，不做词法；简繁同归 zh）
function langOf(text) {
  const c = scriptCounts(text)
  if (c.kana > 0) return 'ja'
  if (c.hangul > 0) return 'ko'
  if (c.cyr >= 3 && c.cyr > c.lat) return 'ru'
  if (c.han >= 2 && c.han >= c.lat * 0.5) return 'zh'
  if (c.lat >= 4) return 'en'
  return null
}

// 这轮思考的主导语言；识别不出返回 null（此时不按语言过滤）
function dominantLang(sc) {
  if (!sc) return null
  if ((sc.kana || 0) >= 3) return 'ja'
  if ((sc.hangul || 0) >= 5) return 'ko'
  const ru = sc.cyr || 0
  const zh = sc.han || 0
  const en = sc.lat || 0
  if (ru >= 24 && ru >= zh && ru >= en * 0.6) return 'ru'
  if (zh >= 24 && zh >= en * 0.6) return 'zh'
  if (en >= 60) return 'en'
  return null
}

const Q_TAIL = /[？?]["'”’)\]]?$/

function looksLikeCode(t) {
  return CODEISH.test(t)
}

/* 各语言的疑问判定。共同前提：不像代码、不是在复述用户原话。 */

// 中文（简体 + 繁体同归 zh）
function looksLikeZhQuestion(t) {
  if (t.length < 5 || t.length > 90) return false
  if ((t.match(/["“”]/g) || []).length % 2 === 1) return false
  if (cjkCount(t) < 3) return false
  if (/(吗[。，,？?]?$|吧[。，,？?]?$)/.test(t) && !SUSPECT.test(t)) return false
  if (QMARK.test(t)) return true
  if (!SUSPECT.test(t)) return false
  if (/(已经|早就|就是说|也就是说|可以看到|检查一下)/.test(t)) return false
  return true
}

// 英文
const EN_ASK =
  /\b(should|could|would|shall|whether|which|what|why|how|do i|do we|does|is it|are we|can i|maybe i should|not sure (?:if|whether)|wonder|need to know)\b/i

function looksLikeEnQuestion(t) {
  if (t.length < 10 || t.length > 140) return false
  if (!Q_TAIL.test(t)) return false
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length < 4 || words.length > 24) return false
  if (!EN_ASK.test(t)) return false
  if (/[_/]/.test(t)) return false
  return true
}

// 日文：问号收尾，或句末是 か/な/の 且带疑问词
const JA_ASK =
  /(べき|どうする|どうしよう|どっち|どれ|かな|だろう|でしょうか|ますか|ですか|したらいい|どうすれば)/
function looksLikeJaQuestion(t) {
  if (t.length < 6 || t.length > 110) return false
  if (Q_TAIL.test(t)) return true
  return JA_ASK.test(t) && /(か|な|の)[。！!]?$/.test(t)
}

// 韩文
const KO_ASK = /(까|나요|어떻게|해야|뭘|무엇|될까|할까|인가|일까|될지)/
function looksLikeKoQuestion(t) {
  if (t.length < 4 || t.length > 110) return false
  if (Q_TAIL.test(t)) return true
  return KO_ASK.test(t) && /(까|나요|지)[。.!]?$/.test(t)
}

// 俄文：几乎总是用问号
function looksLikeRuQuestion(t) {
  if (t.length < 8 || t.length > 140) return false
  return Q_TAIL.test(t)
}

const LANG_FN = {
  zh: looksLikeZhQuestion,
  en: looksLikeEnQuestion,
  ja: looksLikeJaQuestion,
  ko: looksLikeKoQuestion,
  ru: looksLikeRuQuestion,
}

function looksLikeQuestion(text, opts) {
  const t = String(text || '').trim()
  if (!t) return false
  if (QUOTED.test(t)) return false
  if (looksLikeCode(t)) return false
  const lang = langOf(t)
  if (!lang) return false
  const o = opts || {}
  const mode = o.langMode || 'auto'
  // auto=跟随这轮思考的语言；all=不限；其余=只要这一种
  if (mode !== 'auto' && mode !== 'all' && mode !== lang) return false
  if (mode === 'auto' && o.dominant && o.dominant !== lang) return false
  const fn = LANG_FN[lang]
  return fn ? fn(t) : false
}

function normalize(text) {
  return text
    .replace(/[。！？!?；;，,、：:\s"'`「」『』（）()【】\[\]…·—\-]/g, '')
    .toLowerCase()
}

function bigrams(s) {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function similar(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const ratio = a.length / b.length
  if (ratio > 0.6 && ratio < 1.66 && (a.includes(b) || b.includes(a))) return true
  const ga = bigrams(a)
  const gb = bigrams(b)
  if (!ga.size || !gb.size) return false
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter) > 0.66
}

function cleanSentence(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim()
  t = t.replace(MD_PREFIX, '')
  t = t.replace(STOP_PREFIX, '')
  t = t.replace(WRAP_HEAD, '').replace(WRAP_TAIL, '')
  t = t.replace(/\s+/g, ' ').trim()
  // 英文里前面的从句会粘在问句前面（"Let me think. Should I ...?"），只留最后一句
  if (cjkCount(t) === 0 && /[.!?]["')\]]?\s+\S/.test(t)) {
    const parts = t.split(/(?<=[.!?]["')\]]?)\s+/)
    t = parts[parts.length - 1].trim()
  }
  return t
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export default {
  name: 'dsh-question-bubbles',

  apply(root) {
    const config = readConfig()

    /* ---------- 1. 页面注入：必须最先注册，且不能等待服务 ---------- */
    const rowDisposers = []
    root.effect(() => () => {
      for (const d of rowDisposers) {
        try {
          d()
        } catch (err) {
          /* 忽略 */
        }
      }
    })

    rowDisposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.includes(ROUTE_PREFIX + '/client.js')) {
              return
            }
          }
          table.push({ kind: 'script', placement: 'body', text: ROW_TEXT })
        } catch (err) {
          /* 注入失败不影响宿主 */
        }
      }),
    )

    /* ---------- 2. 内存状态 ---------- */
    const counters = { shown: 0, answered: 0, proceeded: 0 }
    /** id -> question */
    const questions = new Map()
    /** sessionId -> tracker */
    const trackers = new Map()
    /** SSE 客户端 */
    const clients = new Set()
    /** 全局节流 */
    let lastEmitAt = 0
    let emitBudget = 20
    let emitBudgetAt = Date.now()

    function trackerOf(sessionId) {
      let t = trackers.get(sessionId)
      if (!t) {
        t = {
          attemptId: null,
          buf: '',
          scanPos: 0,
          seen: new Map(),
          emitted: 0,
          open: [],
          fence: 0,
          sc: null,
        }
        trackers.set(sessionId, t)
      }
      return t
    }

    function beginAttempt(sessionId, attemptId) {
      const t = trackerOf(sessionId)
      t.attemptId = attemptId || null
      t.buf = ''
      t.scanPos = 0
      t.emitted = 0
      t.open = []
      t.fence = 0
      t.sc = null
      // seen 保留 5 分钟，用来跨步去重
      const now = Date.now()
      for (const [k, ts] of t.seen) if (now - ts > 300000) t.seen.delete(k)
    }

    function markProceeded(sessionId) {
      const t = trackers.get(sessionId)
      if (!t || !t.open.length) return
      for (const id of t.open) {
        const q = questions.get(id)
        if (q && q.status === 'open') {
          q.status = 'proceeded'
          counters.proceeded++
          broadcast({ type: 'resolve', id, status: 'proceeded' })
        }
      }
      t.open = []
    }

    function endAttempt(sessionId, attemptId) {
      const t = trackers.get(sessionId)
      if (!t) return
      if (attemptId && t.attemptId && attemptId !== t.attemptId) return
      markProceeded(sessionId)
      t.buf = ''
      t.scanPos = 0
    }

    function emitQuestion(sessionId, text, force) {
      const now = Date.now()
      if (!force) {
        if (now - lastEmitAt < 1200) return
        if (now - emitBudgetAt > 60000) {
          emitBudgetAt = now
          emitBudget = 20
        }
        if (emitBudget <= 0) return
        emitBudget--
        lastEmitAt = now

        const t = trackerOf(sessionId)
        if (t.emitted >= 6) return
        t.emitted++
      }

      const t = trackerOf(sessionId)
      const id = randomUUID()
      const q = {
        id,
        sessionId,
        text,
        ts: now,
        status: 'open',
      }
      questions.set(id, q)
      t.open.push(id)
      counters.shown++

      // 只保留最近 200 条，避免长会话里无限涨
      if (questions.size > 200) {
        const ids = [...questions.keys()].slice(0, questions.size - 200)
        for (const old of ids) questions.delete(old)
      }

      broadcast({ type: 'q', q })
      broadcastCounters()
    }

    function consider(sessionId, raw) {
      const text = cleanSentence(raw)
      const t = trackerOf(sessionId)
      const opts = {
        langMode: config.langMode,
        dominant: dominantLang(t.sc),
      }
      if (process.env.DSH_QB_DEBUG) {
        console.log('[qb] consider', JSON.stringify(text), '=>', looksLikeQuestion(text, opts), JSON.stringify(opts))
      }
      if (!text) return
      if (!looksLikeQuestion(text, opts)) return
      const key = normalize(text)
      if (!key || key.length < 4) return

      for (const k of t.seen.keys()) {
        if (similar(k, key)) return
      }
      t.seen.set(key, Date.now())
      emitQuestion(sessionId, text)
    }

    function onReasoning(sessionId, attemptId, delta) {
      if (!delta) return
      const t = trackerOf(sessionId)
      if (attemptId && t.attemptId && attemptId !== t.attemptId) {
        beginAttempt(sessionId, attemptId)
      }
      // 跟踪这一轮思考的主导语言（auto 模式据此决定认哪种语言的疑问）
      const add = scriptCounts(delta)
      if (!t.sc) t.sc = { han: 0, kana: 0, hangul: 0, cyr: 0, lat: 0 }
      for (const k of Object.keys(add)) t.sc[k] += add[k]
      t.buf += delta
      if (t.buf.length > 8000) {
        const cut = t.buf.length - 8000
        t.buf = t.buf.slice(cut)
        t.scanPos = Math.max(0, t.scanPos - cut)
      }

      // 代码块里的内容不抽（思维链里塞代码很常见）
      const wasInFence = t.fence === 1
      const fences = (delta.match(/```/g) || []).length
      if (fences) t.fence = (t.fence + fences) % 2
      if (wasInFence) {
        t.scanPos = t.buf.length
        return
      }

      const seg = t.buf.slice(t.scanPos)
      const re = /[^。！？!?；;\n]*[。！？!?；;\n]/g
      let last = 0
      let m
      while ((m = re.exec(seg))) {
        last = re.lastIndex
        consider(sessionId, m[0])
      }
      // 尾部还没等到句末、但已经明确以问号收尾的短句
      const tail = seg.slice(last).trim()
      if (tail.length >= 6 && QMARK.test(tail) && /[？?]$/.test(tail)) {
        consider(sessionId, tail)
      }
      t.scanPos += last
    }

    /* ---------- 3. SSE 广播 ---------- */
    function writeEvent(res, payload) {
      try {
        res.write('event: msg\ndata: ' + JSON.stringify(payload) + '\n\n')
        return true
      } catch (err) {
        return false
      }
    }

    function broadcast(payload) {
      for (const res of clients) {
        if (!writeEvent(res, payload)) clients.delete(res)
      }
    }

    function broadcastCounters() {
      broadcast({ type: 'counters', counters })
    }

    function broadcastConfig() {
      broadcast({ type: 'config', config })
    }

    /* ---------- 4. 思考流订阅 ---------- */
    root.on('agent/assistant-stream', (payload) => {
      try {
        if (!config.enabled) return
        if (!payload || !payload.frame || !payload.agent) return
        const sessionId = String(payload.agent.id || '')
        if (!sessionId) return
        const frame = payload.frame

        if (frame.type === 'start') {
          beginAttempt(sessionId, frame.attemptId)
          return
        }
        if (frame.type === 'end') {
          endAttempt(sessionId, frame.attemptId)
          return
        }
        if (frame.type !== 'chunk') return

        const chunk = frame.chunk || {}
        if (chunk.type === 'reasoning-delta') {
          if (typeof chunk.text === 'string' && chunk.text) onReasoning(sessionId, frame.attemptId, chunk.text)
          return
        }
        // 开始说话或调工具 = 已经自己往下走了
        if (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') {
          markProceeded(sessionId)
        }
      } catch (err) {
        /* 单帧异常不影响流 */
        if (process.env.DSH_QB_DEBUG) console.error('[qb] stream error', err)
      }
    })

    /* ---------- 5. HTTP 路由 ---------- */
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      root.effect(() => () => {
        for (const d of disposers) {
          try {
            d()
          } catch (err) {
            /* 忽略 */
          }
        }
        for (const res of clients) {
          try {
            res.end()
          } catch (err) {
            /* 忽略 */
          }
        }
        clients.clear()
      })

      /* ---- 信任栅栏：只认本机页面 ---- */
      function rejected(req, res) {
        try {
          const hostHeader = String(req.headers.host || '')
          const hostname = hostHeader.startsWith('[') ? hostHeader.slice(1, hostHeader.indexOf(']')) : hostHeader.split(':')[0]
          const okHost =
            hostname === 'localhost' ||
            hostname.endsWith('.localhost') ||
            hostname === '::1' ||
            /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
          if (!okHost) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('forbidden')
            return true
          }
          if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('forbidden')
            return true
          }
          const origin = req.headers.origin
          if (origin && origin !== 'null') {
            try {
              if (new URL(origin).host !== hostHeader) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('forbidden')
                return true
              }
            } catch (err) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('forbidden')
              return true
            }
          }
          return false
        } catch (err) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return true
        }
      }

      function register(route) {
        return ctx.webServer.register(
          Object.assign({}, route, {
            handler: async (req, res) => {
              if (rejected(req, res)) return
              return route.handler(req, res)
            },
          }),
        )
      }

      /* ---- 前端脚本（改文件即生效） ---- */
      let cache = { file: null, mtime: 0, js: '' }

      function loadClientJs() {
        for (const file of CLIENT_CANDIDATES) {
          try {
            const st = fs.statSync(file)
            if (!st.isFile()) continue
            if (cache.file === file && cache.mtime === st.mtimeMs) return cache.js
            const js = fs.readFileSync(file, 'utf8')
            cache = { file, mtime: st.mtimeMs, js }
            return js
          } catch (err) {
            /* 换下一个候选 */
          }
        }
        return cache.js || ''
      }

      disposers.push(
        register({
          kind: 'exact',
          path: ROUTE_PREFIX + '/client.js',
          handler: (req, res) => {
            const js = loadClientJs()
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(js)
          },
        }),
      )

      /* ---- SSE ---- */
      disposers.push(
        register({
          kind: 'exact',
          path: ROUTE_PREFIX + '/events',
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
              'Access-Control-Allow-Origin': '*',
            })
            res.write(': connected\n\n')
            clients.add(res)
            try {
              req.socket.setTimeout(0)
              req.socket.setKeepAlive(true)
              res.socket.setNoDelay(true)
            } catch (err) {
              /* 忽略 */
            }
            try {
              res.write(
                'event: msg\ndata: ' +
                  JSON.stringify({
                    type: 'hello',
                    config,
                    counters,
                    questions: [...questions.values()].slice(-8),
                  }) +
                  '\n\n',
              )
            } catch (err) {
              /* 忽略 */
            }
            const cleanup = () => clients.delete(res)
            req.on('close', cleanup)
            req.on('error', cleanup)
            res.on('close', cleanup)
            res.on('error', cleanup)
          },
        }),
      )

      /* ---- 心跳 ---- */
      const heartbeat = setInterval(() => {
        for (const res of clients) {
          try {
            res.write(': ping\n\n')
          } catch (err) {
            clients.delete(res)
          }
        }
      }, 25000)
      try {
        if (heartbeat.unref) heartbeat.unref()
      } catch (err) {
        /* 忽略 */
      }
      disposers.push(() => clearInterval(heartbeat))

      /* ---- 状态 / 配置 ---- */
      function readJson(req, limit = 65536) {
        return new Promise((resolve) => {
          let size = 0
          const chunks = []
          req.on('data', (c) => {
            size += c.length
            if (size > limit) {
              req.destroy()
              resolve(null)
              return
            }
            chunks.push(c)
          })
          req.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (err) {
              resolve(null)
            }
          })
          req.on('error', () => resolve(null))
        })
      }

      function sendJson(res, code, body) {
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify(body))
      }

      disposers.push(
        register({
          kind: 'exact',
          path: ROUTE_PREFIX + '/state',
          handler: (req, res) => {
            sendJson(res, 200, {
              config,
              counters,
              sse: clients.size,
              questions: [...questions.values()].slice(-20),
            })
          },
        }),
      )

      disposers.push(
        register({
          kind: 'exact',
          path: ROUTE_PREFIX + '/config',
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
            const body = await readJson(req)
            if (!body) return sendJson(res, 400, { ok: false })
            if (typeof body.enabled === 'boolean') config.enabled = body.enabled
            if (body.maxBubbles != null) config.maxBubbles = clamp(Math.round(Number(body.maxBubbles) || 9), 1, 9)
            if (typeof body.langMode === 'string' && LANG_MODES.includes(body.langMode)) {
              config.langMode = body.langMode
            }
            const saved = writeConfig({
              enabled: config.enabled,
              maxBubbles: config.maxBubbles,
              langMode: config.langMode,
            })
            broadcastConfig()
            return sendJson(res, 200, { ok: true, saved, config })
          },
        }),
      )

      /* ---- 自测：塞一条假疑问，验证页面能不能画出来 ---- */
      disposers.push(
        register({
          kind: 'exact',
          path: ROUTE_PREFIX + '/demo',
          handler: (req, res) => {
            let text = '这是测试气泡：我能看见吗？'
            try {
              const u = new URL(String(req.url || '/'), 'http://localhost')
              if (u.searchParams.get('text')) text = u.searchParams.get('text')
            } catch (err) {
              /* 忽略 */
            }
            emitQuestion('demo', String(text).slice(0, 90), true)
            sendJson(res, 200, { ok: true })
          },
        }),
      )

      /* ---- 作答：温和排队（steer） ---- */
      disposers.push(
        register({
          kind: 'exact',
          path: ROUTE_PREFIX + '/answer',
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
            const body = await readJson(req)
            if (!body) return sendJson(res, 400, { ok: false, error: 'bad-json' })
            const id = String(body.id || '')
            const text = String(body.text || '').trim()
            if (!id || !text) return sendJson(res, 400, { ok: false, error: 'missing' })
            if (text.length > 2000) return sendJson(res, 400, { ok: false, error: 'too-long' })

            const q = questions.get(id)
            if (!q) return sendJson(res, 404, { ok: false, error: 'no-such-question' })
            if (q.status === 'answered') return sendJson(res, 409, { ok: false, error: 'already-answered' })

            const sc = ctx.get('sessionController')
            if (!sc || typeof sc.prompt !== 'function') {
              return sendJson(res, 503, { ok: false, error: 'no-session-controller' })
            }

            const content = [
              {
                type: 'text',
                text:
                  (langOf(q.text) === 'zh'
                    ? '（补一句，回答你刚才没问出口的疑问「' + q.text.slice(0, 80) + '」）'
                    : '(An answer to a question you left unasked: "' + q.text.slice(0, 160) + '") ') + text,
              },
            ]
            const request = {
              requestId: randomUUID(),
              sessionId: q.sessionId,
              mode: 'steer',
              content,
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }

            try {
              const controller = new AbortController()
              await sc.prompt(request, controller.signal)
            } catch (err) {
              return sendJson(res, 502, { ok: false, error: String((err && err.message) || err) })
            }

            q.status = 'answered'
            counters.answered++
            broadcast({ type: 'resolve', id, status: 'answered' })
            broadcastCounters()
            return sendJson(res, 200, { ok: true })
          },
        }),
      )

      return () => {
        for (const d of disposers) {
          try {
            d()
          } catch (err) {
            /* 忽略 */
          }
        }
      }
    })
  },
}

// 仅供离线测试使用的内部函数出口（运行时无副作用）
export const __test = {
  looksLikeQuestion,
  langOf,
  dominantLang,
  scriptCounts,
  cjkCount,
}
