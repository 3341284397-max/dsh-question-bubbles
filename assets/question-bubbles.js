/**
 * dsh-question-bubbles —— 前端半（注入到页面里的普通脚本，无框架）
 *
 * 行为：
 *   - 订阅 /dsh-qb/events（SSE），收到疑问就画气泡；
 *   - 气泡跟着鲸鱼挂件（.dshwv-root）定位，浮在它上方；
 *   - 点气泡可就地作答，走 POST /dsh-qb/answer（宿主侧温和排队）；
 *   - 中键点鲸鱼开/关设置面板（总开关、最多显示几条、计数器）。
 */

;(function () {
  'use strict'

  if (window.__dshQuestionBubbles) return
  window.__dshQuestionBubbles = true

  var PREFIX = '/dsh-qb'
  var BUBBLE_TTL = 30000
  var MAX_KEEP = 40

  var state = {
    enabled: true,
    maxBubbles: 9,
    langMode: 'auto',
    counters: { shown: 0, answered: 0, proceeded: 0 },
    items: [],
    panelOpen: false,
    hover: false,
  }

  /* ------------------------------------------------------------------ */
  /* 样式                                                                */
  /* ------------------------------------------------------------------ */

  var CSS = [
    '#dsh-qb-root{position:fixed;right:18px;bottom:190px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;}',
    '#dsh-qb-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;}',
    '.dsh-qb-b{position:relative;pointer-events:auto;max-width:300px;min-width:96px;padding:9px 13px 10px;border-radius:15px;background:rgba(30,36,50,.94);color:#eef2ff;border:1px solid rgba(150,170,220,.28);box-shadow:0 8px 24px rgba(8,12,24,.35),0 1px 0 rgba(255,255,255,.06) inset;cursor:pointer;animation:dsh-qb-in .22s cubic-bezier(.2,.9,.3,1.2);transition:opacity .5s ease,transform .22s ease,border-color .2s;backdrop-filter:blur(6px);}',
    '.dsh-qb-b:hover{border-color:rgba(170,195,255,.55);transform:translateY(-1px);}',
    '.dsh-qb-b::after{content:"";position:absolute;right:16px;bottom:-5px;width:10px;height:10px;background:rgba(30,36,50,.94);border-right:1px solid rgba(150,170,220,.28);border-bottom:1px solid rgba(150,170,220,.28);transform:rotate(45deg);border-radius:0 0 3px 0;}',
    '.dsh-qb-t{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;white-space:pre-wrap;}',
    '.dsh-qb-b.full .dsh-qb-t{-webkit-line-clamp:unset;display:block;}',
    '.dsh-qb-f{margin-top:4px;font-size:11px;opacity:0;transition:opacity .2s;color:#a9b6d8;white-space:nowrap;}',
    '.dsh-qb-b:hover .dsh-qb-f{opacity:1;}',
    '.dsh-qb-c{position:absolute;top:-7px;right:-7px;width:19px;height:19px;line-height:16px;text-align:center;font-size:13px;padding:0;border-radius:50%;background:rgba(18,22,34,.97);color:#c9d4f0;border:1px solid rgba(150,170,220,.38);cursor:pointer;opacity:0;transition:opacity .15s,background .15s,color .15s;font-family:inherit;}',
    '.dsh-qb-b:hover .dsh-qb-c{opacity:1;}',
    '.dsh-qb-c:hover{background:#46527a;color:#fff;}',
    '.dsh-qb-b.done{opacity:.62;}',
    '.dsh-qb-b.out{opacity:0;transform:translateY(6px) scale(.96);}',
    '.dsh-qb-b.proceeded{border-color:rgba(150,170,220,.18);}',
    '.dsh-qb-e{pointer-events:auto;cursor:default;}',
    '.dsh-qb-e textarea{display:block;width:260px;max-width:64vw;min-height:44px;max-height:140px;resize:vertical;margin:2px 0 0;padding:6px 8px;border-radius:9px;border:1px solid rgba(150,170,220,.4);background:rgba(12,16,26,.75);color:#eef2ff;font:inherit;outline:none;box-sizing:border-box;}',
    '.dsh-qb-e textarea:focus{border-color:rgba(120,170,255,.85);}',
    '.dsh-qb-a{display:flex;gap:6px;justify-content:flex-end;margin-top:6px;}',
    '.dsh-qb-btn{pointer-events:auto;border:1px solid rgba(150,170,220,.35);background:rgba(255,255,255,.06);color:#dfe6ff;border-radius:8px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;}',
    '.dsh-qb-btn:hover{background:rgba(255,255,255,.13);}',
    '.dsh-qb-btn.primary{background:rgba(96,140,255,.85);border-color:rgba(96,140,255,.9);color:#fff;}',
    '.dsh-qb-btn.primary:hover{background:rgba(120,160,255,.95);}',
    '.dsh-qb-hint{font-size:11px;color:#a9b6d8;margin-top:5px;}',
    '#dsh-qb-panel{pointer-events:auto;width:240px;padding:12px 14px 13px;border-radius:15px;background:rgba(24,29,42,.97);color:#e9eeff;border:1px solid rgba(150,170,220,.3);box-shadow:0 12px 34px rgba(6,10,20,.45);backdrop-filter:blur(10px);display:none;animation:dsh-qb-in .16s ease;}',
    '#dsh-qb-panel.on{display:block;}',
    '.dsh-qb-ph{display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:13px;margin-bottom:10px;}',
    '.dsh-qb-x{border:0;background:transparent;color:#93a1c6;font-size:15px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px;}',
    '.dsh-qb-x:hover{color:#fff;background:rgba(255,255,255,.1);}',
    '.dsh-qb-row{display:flex;align-items:center;justify-content:space-between;padding:5px 0;font-size:12.5px;color:#c9d3ef;}',
    '.dsh-qb-row select{background:rgba(255,255,255,.07);color:#e9eeff;border:1px solid rgba(150,170,220,.3);border-radius:7px;padding:2px 6px;font:inherit;font-size:12px;outline:none;}',
    '.dsh-qb-sw{appearance:none;-webkit-appearance:none;width:34px;height:19px;border-radius:10px;background:rgba(255,255,255,.16);position:relative;cursor:pointer;transition:background .18s;outline:none;}',
    '.dsh-qb-sw:checked{background:rgba(96,140,255,.9);}',
    '.dsh-qb-sw::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .18s;}',
    '.dsh-qb-sw:checked::after{transform:translateX(15px);}',
    '.dsh-qb-stats{margin-top:9px;padding-top:9px;border-top:1px solid rgba(150,170,220,.16);font-size:11.5px;color:#9fadd2;line-height:1.7;}',
    '.dsh-qb-stats b{color:#e9eeff;font-weight:600;}',
    '.dsh-qb-note{margin-top:7px;font-size:10.5px;color:#7f8cb0;line-height:1.6;}',
    '.dsh-qb-hint{font-size:10.5px;color:#7f8cb0;line-height:1.55;margin:-1px 0 5px;}',
    '#dsh-qb-knob{position:fixed;right:14px;bottom:14px;width:30px;height:30px;border-radius:50%;background:rgba(30,36,50,.9);border:1px solid rgba(150,170,220,.35);color:#dfe6ff;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:2147483000;font-size:14px;user-select:none;}',
    '#dsh-qb-knob.on{display:flex;}',
    '@keyframes dsh-qb-in{from{opacity:0;transform:translateY(8px) scale(.94);}to{opacity:1;transform:none;}}',
  ].join('')

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */


  /* ------------------------------------------------------------------ */
  /* 文案：跟随浏览器语言（zh / en / ja / ko / ru，其余回落英文）          */
  /* ------------------------------------------------------------------ */

  var DICT = {
    zh: {
      title: '问题泡泡',
      on: '开启',
      max: '最多显示',
      n: function (v) { return v + ' 条' },
      lang: '识别语言',
      langAuto: '自动（跟随思考）',
      langAll: '全部语言',
      hint: '「自动」只认和这轮思考同一种语言的疑问；想强制只看/全看就在上面选。',
      seen: '出现',
      answered: '你答了',
      moved: '自己走了',
      note: '中键点鲸鱼就能开/关这里。点气泡可直接作答。',
      close: '关闭',
      bubbleClose: '关掉这条',
      bAnswered: '已答 · 排进下一轮',
      bProceeded: '已自行推进 · 仍可回答',
      bHint: '点一下回答 · 右键看全文',
      ph: '回答这个疑问（会排进下一轮，不打断当前这步）',
      send: '发过去',
      cancel: '算了',
      sending: '发送中…',
      retry: '重试',
      already: '这条已经答过了',
      fail: '没发出去：',
      offline: '网络没通，稍后再点'
    },
    en: {
      title: 'Question Bubbles',
      on: 'Enabled',
      max: 'Max shown',
      n: function (v) { return String(v) },
      lang: 'Language',
      langAuto: 'Auto (follow thinking)',
      langAll: 'All languages',
      hint: 'In "Auto" only questions in the same language as the thinking show up. Pick one to force a language.',
      seen: 'Seen',
      answered: 'Answered',
      moved: 'Moved on',
      note: 'Middle-click the whale to open/close this. Click a bubble to answer.',
      close: 'Close',
      bubbleClose: 'Dismiss',
      bAnswered: 'Answered · next round',
      bProceeded: 'Moved on · still answerable',
      bHint: 'Click to answer · right-click for full text',
      ph: 'Your answer (queued for the next round, will not interrupt this step)',
      send: 'Send',
      cancel: 'Skip',
      sending: 'Sending…',
      retry: 'Retry',
      already: 'Already answered',
      fail: 'Not sent: ',
      offline: 'Offline, try again later'
    },
    ja: {
      title: '質問バブル',
      on: '有効',
      max: '最大表示',
      n: function (v) { return v + ' 件' },
      lang: '言語',
      langAuto: '自動（思考に追従）',
      langAll: 'すべての言語',
      hint: '「自動」は思考と同じ言語の質問だけ拾います。強制する場合は上で選択。',
      seen: '出現',
      answered: '回答',
      moved: '独断で進行',
      note: 'クジラを中クリックで開閉。バブルをクリックで回答できます。',
      close: '閉じる',
      bubbleClose: '閉じる',
      bAnswered: '回答済み · 次のラウンド',
      bProceeded: '独断で進行 · 回答可',
      bHint: 'クリックで回答 · 右クリックで全文',
      ph: '回答を入力（次のラウンドに回します。今の作業は止めません）',
      send: '送信',
      cancel: 'やめる',
      sending: '送信中…',
      retry: '再試行',
      already: '回答済みです',
      fail: '送信できません：',
      offline: '通信できません。後でもう一度'
    },
    ko: {
      title: '질문 버블',
      on: '켜기',
      max: '최대 표시',
      n: function (v) { return v + ' 개' },
      lang: '언어',
      langAuto: '자동 (사고 따라가기)',
      langAll: '모든 언어',
      hint: '"자동"은 사고와 같은 언어의 질문만 잡습니다. 강제하려면 위에서 선택하세요.',
      seen: '나타남',
      answered: '답변함',
      moved: '스스로 진행',
      note: '고래를 가운데 클릭하면 열고 닫습니다. 버블을 클릭해 답변하세요.',
      close: '닫기',
      bubbleClose: '닫기',
      bAnswered: '답변함 · 다음 라운드',
      bProceeded: '스스로 진행 · 답변 가능',
      bHint: '클릭해 답변 · 우클릭으로 전체 보기',
      ph: '답변 입력(다음 라운드로 넘어갑니다. 지금 단계는 멈추지 않습니다)',
      send: '보내기',
      cancel: '취소',
      sending: '보내는 중…',
      retry: '다시 시도',
      already: '이미 답변했습니다',
      fail: '전송 실패: ',
      offline: '네트워크 오류. 나중에 다시'
    },
    ru: {
      title: 'Пузыри вопросов',
      on: 'Включено',
      max: 'Показывать',
      n: function (v) { return String(v) },
      lang: 'Язык',
      langAuto: 'Авто (за мышлением)',
      langAll: 'Все языки',
      hint: 'В режиме «Авто» показываются только вопросы на языке размышления. Выберите язык, чтобы задать его вручную.',
      seen: 'Всего',
      answered: 'Отвечено',
      moved: 'Решил сам',
      note: 'Средний клик по киту — открыть/закрыть. Клик по пузырю — ответить.',
      close: 'Закрыть',
      bubbleClose: 'Закрыть',
      bAnswered: 'Отвечено · следующий раунд',
      bProceeded: 'Решил сам · можно ответить',
      bHint: 'Клик — ответить · правый клик — весь текст',
      ph: 'Ваш ответ (уйдёт в следующий раунд, не прерывая текущий шаг)',
      send: 'Отправить',
      cancel: 'Мимо',
      sending: 'Отправка…',
      retry: 'Повторить',
      already: 'Уже отвечено',
      fail: 'Не отправлено: ',
      offline: 'Нет сети, попробуйте позже'
    }
  }

  var UI_LANG = (function () {
    var raw = ((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
    if (raw.indexOf('zh') === 0) return 'zh'
    if (raw.indexOf('ja') === 0) return 'ja'
    if (raw.indexOf('ko') === 0) return 'ko'
    if (raw.indexOf('ru') === 0) return 'ru'
    return 'en'
  })()

  function tr(key, arg) {
    var table = DICT[UI_LANG] || DICT.en
    var value = table[key]
    if (value == null) value = DICT.en[key]
    if (value == null) return key
    return typeof value === 'function' ? value(arg) : value
  }

  var root = document.createElement('div')
  root.id = 'dsh-qb-root'

  var panel = document.createElement('div')
  panel.id = 'dsh-qb-panel'
  panel.innerHTML =
    '<div class="dsh-qb-ph"><span>' + tr('title') + '</span><button class="dsh-qb-x" title="' + tr('close') + '">×</button></div>' +
    '<div class="dsh-qb-row"><span>' + tr('on') + '</span><input type="checkbox" class="dsh-qb-sw"></div>' +
    '<div class="dsh-qb-row"><span>' + tr('max') + '</span><select class="dsh-qb-num">' +
    [1,2,3,4,5,6,7,8,9].map(function (v) { return '<option value="' + v + '">' + tr('n', v) + '</option>' }).join('') +
    '</select></div>' +
    '<div class="dsh-qb-row"><span>' + tr('lang') + '</span><select class="dsh-qb-lang">' +
    '<option value="auto">' + tr('langAuto') + '</option>' +
    '<option value="all">' + tr('langAll') + '</option>' +
    '<option value="zh">中文</option>' +
    '<option value="en">English</option>' +
    '<option value="ja">日本語</option>' +
    '<option value="ko">한국어</option>' +
    '<option value="ru">Русский</option>' +
    '</select></div>' +
    '<div class="dsh-qb-hint">' + tr('hint') + '</div>' +
    '<div class="dsh-qb-stats">' + tr('seen') + ' <b class="dsh-qb-c1">0</b> · ' + tr('answered') + ' <b class="dsh-qb-c2">0</b> · ' + tr('moved') + ' <b class="dsh-qb-c3">0</b></div>' +
    '<div class="dsh-qb-note">' + tr('note') + '</div>'

  var stack = document.createElement('div')
  stack.id = 'dsh-qb-stack'

  var knob = document.createElement('div')
  knob.id = 'dsh-qb-knob'
  knob.textContent = '💭'
  knob.title = tr('title')

  root.appendChild(panel)
  root.appendChild(stack)

  function mount() {
    var style = document.createElement('style')
    style.textContent = CSS
    ;(document.head || document.documentElement).appendChild(style)
    ;(document.body || document.documentElement).appendChild(root)
    document.body.appendChild(knob)
    bindPanel()
    bindMiddleClick()
    trackWhale()
    window.addEventListener('resize', place, { passive: true })
    setInterval(place, 500)
    setInterval(tick, 1000)
    connect()
    fetchState()
  }

  /* ------------------------------------------------------------------ */
  /* 定位：贴着鲸鱼挂件                                                   */
  /* ------------------------------------------------------------------ */

  function whaleEl() {
    return document.querySelector('.dshwv-root')
  }

  var knobForced = false

  function trackWhale() {
    setInterval(function () {
      var has = !!whaleEl()
      knob.classList.toggle('on', !has || knobForced)
      place()
    }, 1500)
  }

  function place() {
    var whale = whaleEl()
    var right = 18
    var bottom = 190
    if (whale) {
      var r = whale.getBoundingClientRect()
      if (r && r.width > 0 && r.height > 0) {
        right = Math.max(8, Math.round(window.innerWidth - r.right + 6))
        bottom = Math.max(8, Math.round(window.innerHeight - r.top + 4))
      }
    }
    root.style.right = right + 'px'
    root.style.bottom = bottom + 'px'
    var w = Math.min(320, Math.max(180, window.innerWidth - 32))
    stack.style.maxWidth = w + 'px'
    panel.style.maxWidth = w + 'px'
  }

  /* ------------------------------------------------------------------ */
  /* 面板                                                                */
  /* ------------------------------------------------------------------ */

  var sw = panel.querySelector('.dsh-qb-sw')
  var num = panel.querySelector('.dsh-qb-num')
  var lang = panel.querySelector('.dsh-qb-lang')
  var c1 = panel.querySelector('.dsh-qb-c1')
  var c2 = panel.querySelector('.dsh-qb-c2')
  var c3 = panel.querySelector('.dsh-qb-c3')

  function bindPanel() {
    panel.querySelector('.dsh-qb-x').addEventListener('click', function () {
      state.panelOpen = false
      syncPanel()
    })
    sw.addEventListener('change', function () {
      state.enabled = !!sw.checked
      saveConfig({ enabled: state.enabled })
      if (!state.enabled) {
        stack.innerHTML = ''
      }
    })
    num.addEventListener('change', function () {
      state.maxBubbles = Number(num.value) || 3
      saveConfig({ maxBubbles: state.maxBubbles })
      render()
    })
    lang.addEventListener('change', function () {
      state.langMode = lang.value || 'auto'
      saveConfig({ langMode: state.langMode })
    })
  }

  function syncPanel() {
    panel.classList.toggle('on', state.panelOpen)
    sw.checked = !!state.enabled
    num.value = String(state.maxBubbles)
    lang.value = state.langMode || 'auto'
    c1.textContent = String(state.counters.shown || 0)
    c2.textContent = String(state.counters.answered || 0)
    c3.textContent = String(state.counters.proceeded || 0)
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen
    syncPanel()
  }

  /* ------------------------------------------------------------------ */
  /* 中键：开/关面板                                                     */
  /* ------------------------------------------------------------------ */

  function bindMiddleClick() {
    window.addEventListener(
      'pointerdown',
      function (e) {
        if (e.pointerType && e.pointerType !== 'mouse') return
        if (e.button !== 1) return
        var whale = whaleEl()
        if (!whale) return
        if (!(whale === e.target || whale.contains(e.target))) return
        e.preventDefault()
        e.stopPropagation()
        togglePanel()
      },
      true,
    )

    window.addEventListener(
      'auxclick',
      function (e) {
        if (e.button !== 1) return
        var whale = whaleEl()
        if (whale && (whale === e.target || whale.contains(e.target))) {
          e.preventDefault()
          e.stopPropagation()
        }
      },
      true,
    )

    knob.addEventListener('click', function () {
      state.panelOpen = !state.panelOpen
      syncPanel()
    })

    // 兜底：没有鲸鱼挂件时，用右下角小圆点开面板
    document.addEventListener(
      'keydown',
      function (e) {
        if (e.key === 'Escape' && state.panelOpen) {
          state.panelOpen = false
          syncPanel()
        }
      },
      true,
    )
  }

  /* ------------------------------------------------------------------ */
  /* SSE                                                                 */
  /* ------------------------------------------------------------------ */

  var es = null
  var retryDelay = 1000

  function connect() {
    try {
      es = new EventSource(PREFIX + '/events')
    } catch (err) {
      setTimeout(connect, 3000)
      return
    }

    es.addEventListener('msg', function (ev) {
      var data
      try {
        data = JSON.parse(ev.data)
      } catch (err) {
        return
      }
      if (!data || !data.type) return
      retryDelay = 1000

      if (data.type === 'hello') {
        state.enabled = !data.config || data.config.enabled !== false
        state.maxBubbles = (data.config && data.config.maxBubbles) || 9
        state.langMode = (data.config && data.config.langMode) || 'auto'
        state.counters = data.counters || state.counters
        if (Array.isArray(data.questions)) {
          for (var i = 0; i < data.questions.length; i++) addItem(data.questions[i], true)
        }
        syncPanel()
        render()
        return
      }

      if (data.type === 'q') {
        addItem(data.q, false)
        render()
        return
      }

      if (data.type === 'resolve') {
        var it = find(data.id)
        if (it) {
          it.status = data.status
          if (data.status === 'answered') it.answeredAt = Date.now()
          paint(it)
        }
        return
      }

      if (data.type === 'config') {
        state.enabled = !data.config || data.config.enabled !== false
        state.maxBubbles = (data.config && data.config.maxBubbles) || 9
        state.langMode = (data.config && data.config.langMode) || 'auto'
        if (!state.enabled) stack.innerHTML = ''
        syncPanel()
        render()
        return
      }

      if (data.type === 'counters') {
        state.counters = data.counters || state.counters
        syncPanel()
      }
    })

    es.addEventListener('error', function () {
      // EventSource 自带重连；这里只做退避兜底
      try {
        es.close()
      } catch (err) {
        /* 忽略 */
      }
      setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 1.6, 15000)
    })
  }

  function fetchState() {
    try {
      fetch(PREFIX + '/state', { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (data) {
          if (!data) return
          state.enabled = !data.config || data.config.enabled !== false
          state.maxBubbles = (data.config && data.config.maxBubbles) || 9
          state.langMode = (data.config && data.config.langMode) || 'auto'
          state.counters = data.counters || state.counters
          syncPanel()
        })
        .catch(function () {})
    } catch (err) {
      /* 忽略 */
    }
  }

  function saveConfig(patch) {
    try {
      fetch(PREFIX + '/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(function () {})
    } catch (err) {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 气泡                                                                */
  /* ------------------------------------------------------------------ */

  function find(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i]
    return null
  }

  function addItem(q, quiet) {
    if (!q || !q.id || !q.text) return
    if (find(q.id)) return
    var item = {
      id: q.id,
      text: String(q.text).replace(/^[\s\-–—]*(?:ask|question|q|疑问|问题|问)\s*[:：]\s*/i, ''),
      status: q.status || 'open',
      createdAt: Number(q.ts) || Date.now(),
      el: null,
      hover: false,
      expanded: false,
      full: false,
      closedAt: 0,
      answeredAt: 0,
    }
    state.items.push(item)
    if (state.items.length > MAX_KEEP) state.items.splice(0, state.items.length - MAX_KEEP)
    if (!quiet) {
      item.el = buildBubble(item)
      if (item.el) stack.appendChild(item.el)
      else item.el = null
    }
    return item
  }

  function buildBubble(item) {
    if (!state.enabled) return null
    var el = document.createElement('div')
    el.className = 'dsh-qb-b'
    el.setAttribute('data-id', item.id)

    var t = document.createElement('div')
    t.className = 'dsh-qb-t'
    t.textContent = item.text

    var f = document.createElement('div')
    f.className = 'dsh-qb-f'

    el.appendChild(t)
    el.appendChild(f)

    var x = document.createElement('button')
    x.type = 'button'
    x.className = 'dsh-qb-c'
    x.title = tr('bubbleClose')
    x.textContent = '×'
    x.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      var ed = el.querySelector('.dsh-qb-e')
      if (ed && ed.parentNode) ed.parentNode.removeChild(ed)
      item.status = 'expired'
      item.hover = false
      render()
    })
    el.appendChild(x)

    el.addEventListener('mouseenter', function () {
      item.hover = true
      updateFoot(item)
    })
    el.addEventListener('mouseleave', function () {
      item.hover = false
    })
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      e.stopPropagation()
      item.full = !item.full
      el.classList.toggle('full', item.full)
    })
    el.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      if (item.status !== 'open') {
        item.full = !item.full
        el.classList.toggle('full', item.full)
        return
      }
      openEditor(item, el)
    })
    return el
  }

  function updateFoot(item) {
    if (!item.el) return
    var f = item.el.querySelector('.dsh-qb-f')
    if (!f) return
    if (item.status === 'answered') f.textContent = tr('bAnswered')
    else if (item.status === 'proceeded') f.textContent = tr('bProceeded')
    else f.textContent = tr('bHint')
  }

  function paint(item) {
    if (!item.el) return
    item.el.classList.toggle('proceeded', item.status === 'proceeded')
    item.el.classList.toggle('done', item.status === 'answered')
    updateFoot(item)
  }

  function render() {
    if (!state.enabled) return
    var open = []
    for (var i = state.items.length - 1; i >= 0 && open.length < state.maxBubbles; i--) {
      var it = state.items[i]
      if (it.status === 'expired' || it.status === 'answered') continue
      open.push(it)
    }
    open.reverse()

    // 超出上限的、已过期的、答完的：淡出
    for (var j = 0; j < state.items.length; j++) {
      var x = state.items[j]
      if (!x.el || open.indexOf(x) !== -1) continue
      if (x.el.classList.contains('out')) continue
      if (x.status === 'answered' && Date.now() - (x.answeredAt || 0) < 2500) continue
      if (x.el.querySelector('.dsh-qb-e')) continue
      fadeOut(x)
    }

    for (var k = 0; k < open.length; k++) {
      var it2 = open[k]
      if (!it2.el) {
        it2.el = buildBubble(it2)
        if (it2.el) {
          stack.appendChild(it2.el)
          paint(it2)
        }
      }
    }
  }

  function fadeOut(item) {
    if (!item.el) return
    item.el.classList.add('out')
    var el = item.el
    setTimeout(function () {
      try {
        el.parentNode && el.parentNode.removeChild(el)
      } catch (err) {
        /* 忽略 */
      }
    }, 520)
    item.el = null
  }

  /* ------------------------------------------------------------------ */
  /* 就地作答                                                            */
  /* ------------------------------------------------------------------ */

  function openEditor(item, el) {
    if (el.querySelector('.dsh-qb-e')) return
    if (item.el !== el) return
    el.classList.add('full')

    var wrap = document.createElement('div')
    wrap.className = 'dsh-qb-e'

    var ta = document.createElement('textarea')
    ta.placeholder = tr('ph')
    ta.rows = 2

    var bar = document.createElement('div')
    bar.className = 'dsh-qb-a'

    var send = document.createElement('button')
    send.className = 'dsh-qb-btn primary'
    send.textContent = tr('send')

    var cancel = document.createElement('button')
    cancel.className = 'dsh-qb-btn'
    cancel.textContent = tr('cancel')

    bar.appendChild(cancel)
    bar.appendChild(send)
    wrap.appendChild(ta)
    wrap.appendChild(bar)
    el.appendChild(wrap)

    setTimeout(function () {
      try {
        ta.focus()
      } catch (err) {
        /* 忽略 */
      }
    }, 0)

    function close() {
      try {
        wrap.parentNode && wrap.parentNode.removeChild(wrap)
      } catch (err) {
        /* 忽略 */
      }
      el.classList.remove('full')
      item.full = false
    }

    cancel.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      close()
    })

    function submit() {
      var text = ta.value.trim()
      if (!text) {
        try {
          ta.focus()
        } catch (err) {
          /* 忽略 */
        }
        return
      }
      send.disabled = true
      send.textContent = tr('sending')
      fetch(PREFIX + '/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, text: text }),
      })
        .then(function (r) {
          return r.json().then(function (body) {
            return { ok: r.ok, body: body }
          })
        })
        .then(function (res) {
          if (res && res.ok && res.body && res.body.ok) {
            item.status = 'answered'
            item.answeredAt = Date.now()
            close()
            paint(item)
            updateFoot(item)
            var f = el.querySelector('.dsh-qb-f')
            if (f) f.textContent = tr('bAnswered')
            state.counters.answered = (state.counters.answered || 0) + 1
            syncPanel()
            setTimeout(function () {
              fadeOut(item)
            }, 2200)
            return
          }
          var msg = (res && res.body && res.body.error) || '发送失败'
          send.disabled = false
          send.textContent = tr('retry')
          var hint = el.querySelector('.dsh-qb-hint')
          if (!hint) {
            hint = document.createElement('div')
            hint.className = 'dsh-qb-hint'
            wrap.appendChild(hint)
          }
          hint.textContent = msg === 'already-answered' ? tr('already') : tr('fail') + msg
        })
        .catch(function () {
          send.disabled = false
          send.textContent = tr('retry')
          var hint = el.querySelector('.dsh-qb-hint')
          if (!hint) {
            hint = document.createElement('div')
            hint.className = 'dsh-qb-hint'
            wrap.appendChild(hint)
          }
          hint.textContent = tr('offline')
        })
    }

    send.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      submit()
    })

    ta.addEventListener('click', function (e) {
      e.stopPropagation()
    })
    ta.addEventListener('keydown', function (e) {
      e.stopPropagation()
      if (e.key === 'Escape') {
        close()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        submit()
      }
    })
  }

  /* ------------------------------------------------------------------ */
  /* 到期淡出                                                            */
  /* ------------------------------------------------------------------ */

  var tip = 0

  function tick() {
    var now = Date.now()
    var changed = false
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i]
      if (!it.el) continue
      if (it.status !== 'open' && it.status !== 'proceeded') continue
      if (it.hover || it.el.querySelector('.dsh-qb-e')) {
        it.createdAt = now
        continue
      }
      if (now - it.createdAt > BUBBLE_TTL) {
        it.status = 'expired'
        fadeOut(it)
        changed = true
      }
    }
    if (changed) render()
  }

  /* ------------------------------------------------------------------ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
})()
