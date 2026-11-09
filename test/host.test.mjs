/**
 * 离线验证 Host 半：不启动 DSH，用假 root/ctx 跑一遍
 *   注入行 → 思考流抽句 → SSE → /state → /answer(steer) → /demo
 * 用法：node plugins/dsh-question-bubbles/test/host.test.mjs
 */
import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'

// 用临时 DSH_HOME，避免读到真实 profile 里被关掉的开关
process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-qb-test-' + process.pid)

const mod = await import(new URL('../lib/index.js', import.meta.url))
const plugin = mod.default
const __test = mod.__test

const handlers = new Map()
const routes = new Map()
const effects = []
const promptCalls = []
let injectTable = null

const fakeCtx = {
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  get(name) {
    if (name === 'sessionController') {
      return {
        async prompt(request, signal) {
          promptCalls.push(request)
          return { accepted: true }
        },
      }
    }
    return undefined
  },
}

const root = {
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(fn)
    return () => {}
  },
  inject(deps, cb) {
    cb(fakeCtx)
    return () => {}
  },
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') effects.push(d)
    return () => {}
  },
}

plugin.apply(root)

// 1) 注入行
const table = []
for (const fn of handlers.get('webserver/index-inject') || []) fn(table)
assert.equal(table.length, 1, '应该注入 1 个 script 行')
assert.ok(table[0].text.includes('/dsh-qb/client.js'), '注入行应指向 client.js')
console.log('✓ 注入行 OK')

// 2) 路由
for (const p of ['/dsh-qb/client.js', '/dsh-qb/events', '/dsh-qb/state', '/dsh-qb/config', '/dsh-qb/answer', '/dsh-qb/demo']) {
  assert.ok(routes.has(p), '缺路由 ' + p)
}
console.log('✓ 路由 OK：' + [...routes.keys()].join(', '))

// 3) 假 req/res
function makeRes() {
  const r = {
    status: 0,
    headers: null,
    body: '',
    chunks: [],
    writeHead(code, headers) {
      this.status = code
      this.headers = headers
    },
    write(s) {
      this.chunks.push(s)
      return true
    },
    end(s) {
      if (s) this.body += s
      this.ended = true
    },
    on() {},
  }
  return r
}
function makeReq(headers = {}, body = '', url = '/') {
  const listeners = {}
  const req = {
    method: headers[':method'] || 'GET',
    url,
    headers: Object.assign({ host: '127.0.0.1:50498' }, headers),
    socket: { setTimeout() {}, setKeepAlive() {} },
    on(ev, fn) {
      listeners[ev] = fn
      if (ev === 'end') {
        setImmediate(() => {
          if (body && listeners.data) listeners.data(Buffer.from(body))
          fn()
        })
      }
      return req
    },
    destroy() {},
  }
  return req
}

// 4) SSE 客户端
const res = makeRes()
await routes.get('/dsh-qb/events').handler(makeReq({ host: '127.0.0.1:50498' }), res)
assert.equal(res.status, 200, 'SSE 应 200')
assert.equal(res.headers['Content-Type'].startsWith('text/event-stream'), true, 'SSE 头不对')
console.log('✓ SSE 打开 OK')

// 5) 喂思考流
const emit = (frame, session = 'sess-1') => {
  for (const fn of handlers.get('agent/assistant-stream') || []) fn({ agent: { id: session }, frame })
}
const sid = 'sess-1'
const aid = 'att-1'
emit({ type: 'start', attemptId: aid, revision: 1, turn: 1, step: 1 })

const chunks = [
  '用户想要一个插件，用来看见我没问出口的疑问。',
  '我需要先确认一下，是要独立插件还是改 whale-widget？这个我不太确定。',
  '先看看 profile 的结构。',
  '另外，气泡的开关放在哪里比较合适？',
  '还有一个问题是，气泡要不要落盘？',
  '嗯，先按不落盘做。',
]
for (const t of chunks) {
  emit({ type: 'chunk', attemptId: aid, revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: t } })
  await new Promise((r) => setTimeout(r, 1300)) // 让 1.2s 节流放行
}

// 6) /state 看抽到几条
const stRes = makeRes()
await routes.get('/dsh-qb/state').handler(makeReq({ host: '127.0.0.1:50498' }), stRes)
const st = JSON.parse(stRes.body)
console.log('抽取到的疑问：')
for (const q of st.questions) console.log('  • ' + q.text + '  [' + q.status + ']')
assert.ok(st.questions.length >= 2, '至少应抽到 2 条，实际 ' + st.questions.length)
assert.ok(
  st.questions.some((q) => q.text.includes('独立插件')),
  '应抽到「独立插件还是改 whale-widget」',
)
assert.ok(!st.questions.some((q) => q.text.startsWith('用户想要')), '不应把陈述句当疑问')

// SSE 里应已经有 q 事件
const sseText = res.chunks.join('')
assert.ok(sseText.includes('"type":"q"'), 'SSE 应推送 q 事件')
console.log('✓ 抽句 + SSE 推送 OK（' + st.questions.length + ' 条）')

// 7) 正文开始 ⇒ 已自行推进
emit({ type: 'chunk', attemptId: aid, revision: 1, index: 1, time: 0, chunk: { type: 'text-delta', index: 1, text: '好，我这就开始。' } })
const stRes2 = makeRes()
await routes.get('/dsh-qb/state').handler(makeReq({ host: '127.0.0.1:50498' }), stRes2)
const st2 = JSON.parse(stRes2.body)
assert.ok(st2.questions.every((q) => q.status === 'proceeded'), '正文开始后应标 proceeded')
assert.equal(st2.counters.proceeded, st2.questions.length)
console.log('✓ 已自行推进标记 OK')

// 7b) 英文碎片 / 代码块 不应成泡（真实噪声回归）
emit({ type: 'start', attemptId: 'att-en', revision: 1, turn: 1, step: 1 }, 'sess-en')
for (const t of [
  'Then /dsh-qb/demo?',
  'Also concern: extraction quality — "Then /dsh-qb/demo?',
  'Let me look at the text: "Then /dsh-qb/demo?',
  'Make the host read lib/index.js fresh?',
]) {
  emit({ type: 'chunk', attemptId: 'att-en', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: t } }, 'sess-en')
}

emit({ type: 'start', attemptId: 'att-fence', revision: 1, turn: 1, step: 1 }, 'sess-fence')
for (const t of ['看下这段：\n```js\n这是代码里的问题吗？\n```\n好。']) {
  emit({ type: 'chunk', attemptId: 'att-fence', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: t } }, 'sess-fence')
}

const stResEn = makeRes()
await routes.get('/dsh-qb/state').handler(makeReq({ host: '127.0.0.1:50498' }), stResEn)
const stEn = JSON.parse(stResEn.body)
const noisy = stEn.questions.filter((q) => q.sessionId === 'sess-en' || q.sessionId === 'sess-fence')
assert.equal(noisy.length, 0, '英文碎片/代码块不应成泡，实际：' + JSON.stringify(noisy.map((q) => q.text)))
console.log('✓ 英文碎片与代码块已过滤')

// 7c) 多语种：文字系统识别 → 各语言疑问判定 → auto 模式跟随思考语言
const T = __test
assert.equal(T.langOf('我需要先确认一下，是独立插件还是改 whale-widget？'), 'zh', '中文')
assert.equal(T.langOf('Should I hang it in the whale menu?'), 'en', '英文')
assert.equal(T.langOf('これはどこに置くべき？'), 'ja', '日文')
assert.equal(T.langOf('이걸 어디에 둬야 할까?'), 'ko', '韩文')
assert.equal(T.langOf('Куда лучше это положить?'), 'ru', '俄文')

assert.equal(T.looksLikeQuestion('Should I hang it in the whale menu, or keep a separate panel?', { langMode: 'zh' }), false, 'zh 模式不认英文')
assert.equal(T.looksLikeQuestion('Should I hang it in the whale menu, or keep a separate panel?', { langMode: 'auto', dominant: 'zh' }), false, 'auto + 中文思考不认英文')
assert.equal(T.looksLikeQuestion('Should I hang it in the whale menu, or keep a separate panel?', { langMode: 'auto', dominant: 'en' }), true, 'auto + 英文思考认英文')
assert.equal(T.looksLikeQuestion('これはどこに置くべき？', { langMode: 'auto', dominant: 'ja' }), true, '日文应认')
assert.equal(T.looksLikeQuestion('이걸 어디에 둬야 할까?', { langMode: 'auto', dominant: 'ko' }), true, '韩文应认')
assert.equal(T.looksLikeQuestion('Куда лучше это положить?', { langMode: 'auto', dominant: 'ru' }), true, '俄文应认')
assert.equal(T.looksLikeQuestion('Make the host read lib/index.js fresh?', { langMode: 'all' }), false, '碎片即使 all 也丢')
console.log('✓ 多语种识别 OK（zh/en/ja/ko/ru）')

const EN_OPEN = 'Let me think about where this toggle belongs. Should I hang it in the whale menu, or keep a separate panel? '
const EN_Q = 'Also I am not sure whether the counter should be per session. Which one is simpler to reason about? '

// 集成：auto 模式下，纯英文思考里的英文问句应冒泡
const cfgRes = makeRes()
await routes.get('/dsh-qb/config').handler(
  makeReq({ host: '127.0.0.1:50498', ':method': 'POST', 'content-type': 'application/json' }, JSON.stringify({ langMode: 'auto' })),
  cfgRes,
)
assert.equal(JSON.parse(cfgRes.body).config.langMode, 'auto', 'config 应记下 langMode')

emit({ type: 'start', attemptId: 'att-enq', revision: 1, turn: 1, step: 1 }, 'sess-enq')
emit({ type: 'chunk', attemptId: 'att-enq', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: EN_OPEN } }, 'sess-enq')
await new Promise((r) => setTimeout(r, 1300))
emit({ type: 'chunk', attemptId: 'att-enq', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: EN_Q } }, 'sess-enq')

const stResEnq = makeRes()
await routes.get('/dsh-qb/state').handler(makeReq({ host: '127.0.0.1:50498' }), stResEnq)
const enq = JSON.parse(stResEnq.body).questions.filter((q) => q.sessionId === 'sess-enq')
assert.ok(enq.length >= 1, '英文思考里应冒英文泡泡，实际 ' + enq.length)
console.log('✓ auto 模式跟随英文思考 OK（' + enq.map((q) => q.text).join(' | ') + '）')

// 锁成中文后，同样的英文句子不该再冒
await new Promise((r) => setTimeout(r, 1300))
const cfgRes2 = makeRes()
await routes.get('/dsh-qb/config').handler(
  makeReq({ host: '127.0.0.1:50498', ':method': 'POST', 'content-type': 'application/json' }, JSON.stringify({ langMode: 'zh' })),
  cfgRes2,
)
emit({ type: 'start', attemptId: 'att-enq2', revision: 1, turn: 1, step: 1 }, 'sess-enq2')
emit({ type: 'chunk', attemptId: 'att-enq2', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: EN_OPEN } }, 'sess-enq2')
const stResEnq2 = makeRes()
await routes.get('/dsh-qb/state').handler(makeReq({ host: '127.0.0.1:50498' }), stResEnq2)
const enq2 = JSON.parse(stResEnq2.body).questions.filter((q) => q.sessionId === 'sess-enq2')
assert.equal(enq2.length, 0, '锁中文后不应再冒英文泡泡')
console.log('✓ 锁定中文后不再冒英文泡泡')

// 8) 作答
const qid = st2.questions[0].id
const ansRes = makeRes()
await routes.get('/dsh-qb/answer').handler(
  makeReq({ host: '127.0.0.1:50498', ':method': 'POST', 'content-type': 'application/json' }, JSON.stringify({ id: qid, text: '独立插件，别改 whale。' })),
  ansRes,
)
const ans = JSON.parse(ansRes.body || '{}')
assert.equal(ans.ok, true, '作答应成功：' + ansRes.body)
assert.equal(promptCalls.length, 1, '应调用一次 prompt')
assert.equal(promptCalls[0].mode, 'steer', '应为 steer 模式')
assert.equal(promptCalls[0].sessionId, 'sess-1')
assert.ok(promptCalls[0].content[0].text.includes('独立插件'), '答案文本应带上')
assert.ok(promptCalls[0].requestId, '应有 requestId')
console.log('✓ 作答 → steer 注入 OK')
console.log('    payload = ' + JSON.stringify(promptCalls[0].content[0].text))

// 9) 信任栅栏
const badRes = makeRes()
await routes.get('/dsh-qb/state').handler(makeReq({ host: 'evil.example.com' }), badRes)
assert.equal(badRes.status, 403, '非回环 Host 应 403')
const badRes2 = makeRes()
await routes.get('/dsh-qb/state').handler(makeReq({ host: '127.0.0.1:50498', 'sec-fetch-site': 'cross-site' }), badRes2)
assert.equal(badRes2.status, 403, 'cross-site 应 403')
console.log('✓ 信任栅栏 OK')

// 10) demo 路由：塞假疑问
const demoRes = makeRes()
await routes.get('/dsh-qb/demo').handler(makeReq({ host: '127.0.0.1:50498' }, '', '/dsh-qb/demo?text=%E6%B5%8B%E8%AF%95%E6%B3%A1%E6%B3%A1'), demoRes)
assert.equal(JSON.parse(demoRes.body).ok, true, 'demo 应成功')
const stRes3 = makeRes()
await routes.get('/dsh-qb/state').handler(makeReq({ host: '127.0.0.1:50498' }), stRes3)
const st3 = JSON.parse(stRes3.body)
assert.ok(st3.questions.some((q) => q.text === '测试泡泡'), 'demo 应产生一条疑问')
console.log('✓ demo 路由 OK')

console.log('\n全部通过。')
process.exit(0)
