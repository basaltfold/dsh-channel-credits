/* dsh-channel-credits — 浏览器半边
 *
 * 两个挂载点：
 *   conversation.composer.dock  → 统计栏常驻「剩余积分」（CSS order:1 排在上下文环右边）
 *                                 点击打开看板：按渠道 / 账号拆分余额
 *   conversation.chat.turnTail  → 每轮尾部回填「本轮消耗」（余额差量，延迟 ~60-100s 结算）
 *                                 并归因到具体账号（哪个号的余额掉了）
 *
 * 数据来自 dsh-our-free-model 注册的 channel-pack RPC 服务：
 *   connection.rpc.call('/api', 'channel-pack', { method, payload }, signal)
 *
 * 口径：宿主的 usage.badge 只给「余额」，上游不返回任何单次消耗字段，
 * 所以「本轮消耗」= 回合结束后余额基线与结算后余额的差量，属于实测值而非上游账单。
 */

window.__ModuleLoader__.load({
  id: 'dsh-channel-credits',
  factory: function (require) {
    var React = require('react')
    var ReactDOM = null
    try { ReactDOM = require('react-dom') } catch (e) { ReactDOM = null }
    var createPortal = null
    if (ReactDOM && typeof ReactDOM.createPortal === 'function') createPortal = ReactDOM.createPortal

    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    /* ---------------------------------------------------------------- 常量 */

    var ALL_PROVIDERS = [
      'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
      'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
    ]

    var PROVIDER_LABEL = {
      codearts: 'CodeArts', buddy: 'WorkBuddy', workbuddy: 'WorkBuddy 国际',
      lobsterai: 'LobsterAI', qoder: 'Qoder', qodercn: 'Qoder 中国版',
      trae: 'TRAE', cline: 'Cline', loomy: 'Loomy', raccoon: 'Raccoon',
      minimax: 'MiniMax', zcode: 'ZCode', gemini: 'Gemini',
    }

    // 只有这三家带自定义计量单位，其余都按「积分」算
    var UNIT_LABEL = { cline: '$', zcode: 'tok', gemini: '额度' }
    function unitOf(provider) { return UNIT_LABEL[provider] || '积分' }

    var POLL_MS = 120000          // 常驻轮询（宿主徽标缓存 TTL 也是 120s，实际不会打穿上游）
    var FORCE_GAP_MS = 12000      // 非结算场景的强刷最小间隔
    var STATUS_TTL_MS = 600000    // provider.status 的本地缓存（账号增减不频繁）
    var SETTLE_ATTEMPTS = [70000, 120000, 180000]  // 回合结束后的结算采样点
    var CLAIM_DELAY_MS = 600      // 让同一会话里所有 turnTail 先报到，再决定谁结算
    var EXPIRING_WINDOW_MS = 15 * 24 * 60 * 60 * 1000  // 与宿主 BUDDY_EXPIRING_WINDOW_DAYS 一致
    var EPS = 0.004

    var CSS = [
      /* ---- 统计栏常驻读数 ---- */
      '.dcc-anchor{order:1;display:inline-flex;align-items:center;min-width:0}',
      '.dcc-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);',
      'color:var(--dsw-alias-label-secondary);font-family:inherit;',
      'font-size:var(--dsh-content-font-size-secondary,13px);',
      'font-variant-numeric:tabular-nums;',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;',
      'padding:1px 8px;display:inline-flex;cursor:pointer}',
      'button.dcc-pill:hover,button.dcc-pill[aria-expanded="true"]{',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dcc-pill[data-loading="true"]{opacity:.55}',
      '.dcc-dot{width:6px;height:6px;border-radius:50%;background:currentColor;',
      'display:inline-block;flex:none;opacity:.7}',

      /* ---- 回合尾部消耗 ---- */
      '.dcc-turn{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'font-size:var(--dsh-content-font-size-secondary,13px);',
      'font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);',
      'font-weight:500;white-space:nowrap;padding:1px 8px;',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.dcc-turn-who{color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.dcc-turn[data-pending="true"]{opacity:.6;border-style:dashed;font-weight:400}',

      /* ---- 点击看板 ---- */
      '.dcc-panel{position:fixed;z-index:1100;box-sizing:border-box;',
      'border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);',
      'backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
      'box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);',
      'cursor:default;border:0;padding:14px 16px;font-size:12px;line-height:18px;',
      'width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px)}',
      '.dcc-panel-title{color:var(--dsw-alias-label-primary);justify-content:space-between;',
      'gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
      '.dcc-panel-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}',
      '.dcc-panel-title-value{font-variant-numeric:tabular-nums}',
      '.dcc-panel-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.dcc-grid{grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:5px 16px;',
      'margin:0;display:grid}',
      '.dcc-grid dt,.dcc-grid dd{min-width:0;margin:0}',
      '.dcc-grid dt{color:var(--dsw-alias-label-tertiary)}',
      '.dcc-grid dd{color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums;text-align:right}',
      '.dcc-grid .dcc-prov{color:var(--dsw-alias-label-secondary);font-weight:500;margin-top:4px}',
      '.dcc-grid .dcc-prov-first{margin-top:0}',
      '.dcc-grid .dcc-prov-val{font-weight:500;margin-top:4px}',
      '.dcc-grid .dcc-acc{color:var(--dsw-alias-label-tertiary);padding-left:12px}',
      '.dcc-grid .dcc-acc-val{color:var(--dsw-alias-label-tertiary);padding-left:12px}',
      '.dcc-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;',
      'margin-top:10px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dcc-refresh{border:none;background:0 0;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:11px;cursor:pointer;padding:2px 8px;',
      'border-radius:var(--dsw-radius-xs)}',
      '.dcc-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dcc-refresh:disabled{opacity:.5;cursor:default}',
    ].join('')

    /* --------------------------------------------------------------- 工具 */

    function messageOf(err) {
      if (!err) return 'failed'
      return err.message || err.code || String(err)
    }

    function unwrap(result) {
      var cur = result
      for (var i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
        if (cur.ok === false) {
          var err = new Error((cur.error && (cur.error.message || cur.error.code)) || 'rpc-failed')
          err.code = cur.error && cur.error.code
          throw err
        }
        if (cur.ok === true && Object.prototype.hasOwnProperty.call(cur, 'value')) {
          cur = cur.value
          continue
        }
        break
      }
      return cur
    }

    function groupThousands(text) {
      return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function fmt(value, digits) {
      var n = Number(value)
      if (!isFinite(n)) return '—'
      if (digits !== undefined) return n.toFixed(digits)
      var abs = Math.abs(n)
      if (abs >= 1000) return groupThousands(String(Math.round(n)))
      if (abs >= 100) return n.toFixed(0)
      if (abs >= 10) return n.toFixed(1)
      return n.toFixed(2)
    }

    // 账号级金额固定两位小数（613.48 不能被抹成 613），千分位照加
    function fmtCredit(value) {
      var n = Number(value)
      if (!isFinite(n)) return '—'
      var fixed = (Math.round(n * 100) / 100).toFixed(2)
      var parts = fixed.split('.')
      return groupThousands(parts[0]) + '.' + parts[1]
    }

    function timeText(ms) {
      if (!ms) return '—'
      try { return new Date(ms).toLocaleTimeString() } catch (e) { return '—' }
    }

    function makeRpc(ctx) {
      return function callChannelPack(method, payload, timeoutMs) {
        var conn = null
        try { conn = ctx.connection } catch (e) { /* service not ready */ }
        if (conn === undefined || conn === null) {
          try { conn = ctx.get('connection') } catch (e) { /* service not ready */ }
        }
        var call = conn && conn.rpc && conn.rpc.call
        if (typeof call !== 'function') return Promise.reject(new Error('no-connection'))
        var ctrl = new AbortController()
        var timer = setTimeout(function () { ctrl.abort() }, timeoutMs || 60000)
        return Promise.resolve()
          .then(function () {
            return call.call(conn.rpc, '/api', 'channel-pack', { method: method, payload: payload }, ctrl.signal)
          })
          .then(unwrap)
          .finally(function () { clearTimeout(timer) })
      }
    }

    /* ------------------------------------------------------------ 到期拆分 */

    // 包的截止时间可能是数字时间戳，也可能是 ISO 字符串
    function endTimeOf(pkg) {
      if (!pkg) return null
      var v = pkg.deductionEndTime
      if (typeof v === 'number' && isFinite(v)) return v
      if (typeof v === 'string') {
        var t = Date.parse(v)
        if (isFinite(t)) return t
      }
      return null
    }

    // 与宿主 splitBuddyCreditsByExpiry() 同口径：只算 active 且 remaining > 0 的包
    function expiryOf(bal) {
      var expiring = 0
      var permanent = 0
      var packages = bal && bal.packages
      if (Array.isArray(packages)) {
        var now = Date.now()
        for (var i = 0; i < packages.length; i++) {
          var pkg = packages[i]
          if (!pkg || pkg.active !== true) continue
          var remaining = Number(pkg.remaining)
          if (!isFinite(remaining) || remaining <= 0) continue
          var end = endTimeOf(pkg)
          if (end !== null && end - now < EXPIRING_WINDOW_MS) expiring += remaining
          else permanent += remaining
        }
      }
      return { expiring: expiring, permanent: permanent }
    }

    /* ------------------------------------------------------------ 余额仓库 */
    /* 全 provider 聚合成一份读数，所有组件订阅同一份，避免多会话重复打上游 */

    var store = { status: 'idle', rows: [], total: 0, unit: '积分', at: 0, error: null }
    var listeners = new Set()
    var inflight = null
    var lastForceAt = 0
    var statusCache = null

    function publish(next) {
      store = next
      listeners.forEach(function (fn) { try { fn(store) } catch (e) { /* ignore */ } })
    }

    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }

    function useStore() {
      var st = useState(store)
      var value = st[0]
      var setValue = st[1]
      useEffect(function () {
        setValue(store)
        return subscribe(function (next) { setValue(next) })
      }, [])
      return value
    }

    function normalizeBadge(provider, value) {
      var accounts = (value && value.accounts) || []
      var total = 0
      var expiring = 0
      var permanent = 0
      var rows = []
      var valid = 0
      var firstError = null
      for (var i = 0; i < accounts.length; i++) {
        var acc = accounts[i] || {}
        var bal = acc.balance
        if (bal && typeof bal.total === 'number' && isFinite(bal.total)) {
          var split = expiryOf(bal)
          total += bal.total
          expiring += split.expiring
          permanent += split.permanent
          valid += 1
          rows.push({
            id: acc.accountId,
            nickname: acc.nickname || '',
            total: bal.total,
            expiring: split.expiring,
            permanent: split.permanent,
          })
        } else if (acc.error) {
          if (firstError === null) firstError = acc.error
          rows.push({ id: acc.accountId, nickname: acc.nickname || '', error: acc.error })
        }
      }
      // 有账号但一个余额都读不出来（凭据缺失等）→ 记 error，不参与合计也不贡献 0
      var status = valid > 0 ? 'ready' : (accounts.length > 0 ? 'error' : 'empty')
      return {
        provider: provider,
        status: status,
        unit: unitOf(provider),
        total: total,
        expiring: expiring,
        permanent: permanent,
        accounts: rows,
        error: status === 'error' ? (firstError || '读数失败') : null,
      }
    }

    // 只对真有账号的 provider 取余额：宿主是逐账号顺序打上游的，不能盲目全量轮询
    function discover(rpc, force) {
      var now = Date.now()
      if (!force && statusCache && now - statusCache.at < STATUS_TTL_MS) {
        return Promise.resolve(statusCache.active)
      }
      return rpc('provider.status', { providers: ALL_PROVIDERS }, 30000)
        .then(function (value) {
          var statuses = (value && value.statuses) || {}
          var active = []
          ALL_PROVIDERS.forEach(function (provider) {
            var status = statuses[provider]
            if (!status || status.closed === true) return
            var accounts = status.accounts || {}
            if ((accounts.total || 0) > 0) active.push(provider)
          })
          statusCache = { at: Date.now(), active: active }
          return active
        })
        .catch(function () {
          // provider.status 不可用时退化为「已知三家」，让界面仍能出数
          return ['buddy', 'qoder', 'trae']
        })
    }

    function summarize(rows) {
      var total = 0
      var expiring = 0
      var units = {}
      var ready = []
      var rest = []
      rows.forEach(function (row) {
        if (row.status === 'ready') {
          ready.push(row)
          total += row.total
          expiring += row.expiring || 0
          units[row.unit] = true
        } else {
          // 空 provider（没账号）不展示，只有账号出问题才在面板里留一行提示
          if (row.status === 'error') rest.push(row)
        }
      })
      var unitList = Object.keys(units)
      return {
        status: ready.length > 0 ? 'ready' : 'empty',
        rows: ready.concat(rest),
        total: total,
        expiring: expiring,
        unit: unitList.length === 1 ? unitList[0] : '积分',
        at: Date.now(),
        error: null,
      }
    }

    function refresh(force, rpc, ignoreGap) {
      if (typeof rpc !== 'function') return Promise.reject(new Error('no-connection'))
      var now = Date.now()
      var wantForce = force === true && (ignoreGap === true || now - lastForceAt > FORCE_GAP_MS)

      if (inflight) {
        // 已经有请求在飞：普通读直接复用；强刷要等它结束再打一次，否则可能拿到复用读数
        if (!wantForce) return inflight
        var again = function () { return refresh(force, rpc, ignoreGap) }
        return inflight.then(again, again)
      }

      if (wantForce) lastForceAt = now
      publish({
        status: 'loading',
        rows: store.rows,
        total: store.total,
        expiring: store.expiring,
        unit: store.unit,
        at: store.at,
        error: null,
      })

      inflight = discover(rpc, false)
        .then(function (active) {
          var rows = []
          // 顺序而非并发：上游对并发查询有风控，宿主自己也是顺序打的
          return active.reduce(function (chain, provider) {
            return chain.then(function () {
              return rpc('usage.badge', { provider: provider, force: wantForce }, 30000)
                .then(function (value) { rows.push(normalizeBadge(provider, value)) })
                .catch(function (err) {
                  rows.push({
                    provider: provider,
                    status: 'error',
                    unit: unitOf(provider),
                    total: 0,
                    expiring: 0,
                    accounts: [],
                    error: messageOf(err),
                  })
                })
            })
          }, Promise.resolve()).then(function () { return summarize(rows) })
        })
        .then(function (next) { publish(next); return next })
        .catch(function (err) {
          publish({
            status: store.status === 'ready' ? 'ready' : 'error',
            rows: store.rows,
            total: store.total,
            expiring: store.expiring,
            unit: store.unit,
            at: store.at,
            error: messageOf(err),
          })
          throw err
        })
        .finally(function () { inflight = null })

      return inflight
    }

    // 全应用只跑一个轮询器（切换会话、多窗口的统计栏共用）
    var booted = false
    function ensurePoller(rpc) {
      if (booted || typeof rpc !== 'function') return
      booted = true
      var tick = function () {
        if (listeners.size === 0) return
        refresh(false, rpc).catch(function () { /* surfaced in state */ })
      }
      tick()
      setInterval(tick, POLL_MS)
    }

    /* ------------------------------------------------------------ 账号快照 */

    // 一次读数里所有账号的余额，用来做「哪个号被扣了」的归因
    function accountTotalsOf(snap) {
      var out = {}
      if (!snap || !snap.rows) return out
      for (var i = 0; i < snap.rows.length; i++) {
        var row = snap.rows[i]
        if (!row || row.status !== 'ready') continue
        var accounts = row.accounts || []
        for (var j = 0; j < accounts.length; j++) {
          var acc = accounts[j]
          if (!acc || acc.error) continue
          if (typeof acc.total !== 'number' || !isFinite(acc.total)) continue
          out[acc.id] = {
            total: acc.total,
            nickname: acc.nickname || '',
            provider: row.provider,
            unit: row.unit,
          }
        }
      }
      return out
    }

    function diffAccounts(base, next) {
      var rows = []
      var sum = 0
      Object.keys(next).forEach(function (id) {
        var before = base[id]
        if (!before) return
        var delta = before.total - next[id].total
        if (!(delta > EPS)) return
        rows.push({
          id: id,
          nickname: next[id].nickname || before.nickname || '',
          provider: next[id].provider,
          delta: delta,
        })
        sum += delta
      })
      rows.sort(function (a, b) { return b.delta - a.delta })
      return { delta: sum, accounts: rows }
    }

    /* --------------------------------------------------------- 当前 provider */

    // 目录里的 provider id 可能带前缀（'dsh-our-free-model/qoder'），取末段再比对
    function providerIdOf(raw) {
      if (typeof raw !== 'string') return null
      var id = raw
      var slash = id.lastIndexOf('/')
      if (slash >= 0) id = id.slice(slash + 1)
      var colon = id.lastIndexOf(':')
      if (colon >= 0) id = id.slice(colon + 1)
      return PROVIDER_LABEL[id] ? id : null
    }

    function useActiveProvider(useProjection) {
      var sel
      if (typeof useProjection === 'function') {
        try { sel = useProjection('modelSelection') } catch (e) { sel = undefined }
      }
      var projected = sel && (sel.next || sel.lastUsed)
      return providerIdOf(projected && projected.provider)
    }

    /* ------------------------------------------------------------ 上一轮记录 */
    /* 让常驻看板也能看到「刚刚那一轮是谁花的」 */

    var lastTurnStore = null
    var lastTurnListeners = new Set()

    function publishLastTurn(next) {
      lastTurnStore = next
      lastTurnListeners.forEach(function (fn) { try { fn(lastTurnStore) } catch (e) { /* ignore */ } })
    }

    function useLastTurn() {
      var st = useState(lastTurnStore)
      var value = st[0]
      var setValue = st[1]
      useEffect(function () {
        setValue(lastTurnStore)
        lastTurnListeners.add(setValue)
        return function () { lastTurnListeners.delete(setValue) }
      }, [])
      return value
    }

    function accountWhoText(accounts) {
      if (!accounts || accounts.length === 0) return ''
      if (accounts.length === 1) {
        var one = accounts[0]
        return one.nickname || providerIdLabel(one.provider) || ''
      }
      return accounts.length + ' 个账号'
    }

    function providerIdLabel(provider) {
      return PROVIDER_LABEL[provider] || provider || ''
    }

    /* ------------------------------------------------------------- 面板定位 */

    var PANEL_MARGIN = 12
    var PANEL_GAP = 8

    function usePanelPlacement(open, anchorRef, panelRef) {
      var st = useState(null)
      var pos = st[0]
      var setPos = st[1]

      useEffect(function () {
        if (!open) { setPos(null); return }
        var frame = 0

        function place() {
          var anchor = anchorRef.current
          if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return
          var rect = anchor.getBoundingClientRect()
          var panel = panelRef.current
          var pw = panel && panel.offsetWidth ? panel.offsetWidth : 300
          var ph = panel && panel.offsetHeight ? panel.offsetHeight : 180
          var vw = window.innerWidth || 0
          var vh = window.innerHeight || 0

          var left = rect.left + rect.width / 2 - pw / 2
          var maxLeft = Math.max(PANEL_MARGIN, vw - pw - PANEL_MARGIN)
          left = Math.max(PANEL_MARGIN, Math.min(left, maxLeft))

          // 优先放在触发条的上面（统计栏贴着窗口底部），放不下再翻到下面
          var top = rect.top - ph - PANEL_GAP
          if (top < PANEL_MARGIN) {
            var below = rect.bottom + PANEL_GAP
            top = below + ph + PANEL_MARGIN <= vh ? below : Math.max(PANEL_MARGIN, vh - ph - PANEL_MARGIN)
          }

          setPos({ left: Math.round(left), top: Math.round(top) })
        }

        place()
        frame = window.requestAnimationFrame(place)
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return function () {
          if (frame) window.cancelAnimationFrame(frame)
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      return pos
    }

    function useDismiss(open, setOpen, anchorRef, panelRef) {
      useEffect(function () {
        if (!open) return

        function onKeyDown(event) {
          if (event.key === 'Escape') setOpen(false)
        }
        function onPointerDown(event) {
          var target = event.target
          if (!target || typeof target !== 'object') return
          var anchor = anchorRef.current
          var panel = panelRef.current
          if (anchor && anchor.contains(target)) return
          if (panel && panel.contains(target)) return
          setOpen(false)
        }

        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return function () {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])
    }

    /* ------------------------------------------------------------- 常驻读条 */

    function activeRowOf(snap, active) {
      if (!active) return null
      for (var i = 0; i < snap.rows.length; i++) {
        if (snap.rows[i].provider === active && snap.rows[i].status === 'ready') return snap.rows[i]
      }
      return null
    }

    function panelContent(snap, active, loading, lastTurn, onRefresh) {
      var nodes = []
      var rows = (snap && snap.rows) || []

      nodes.push(h('div', { key: 'title', className: 'dcc-panel-title' }, [
        h('span', { key: 'label', className: 'dcc-panel-title-label' }, '渠道积分'),
        h('span', { key: 'value', className: 'dcc-panel-title-value' },
          fmt(snap.total) + ' ' + snap.unit),
      ]))
      nodes.push(h('div', { key: 'rule', className: 'dcc-panel-rule' }))

      var cells = []
      var first = true
      rows.forEach(function (row) {
        var name = providerIdLabel(row.provider)
        var active2 = row.provider === active
        if (row.status === 'error') {
          cells.push(h('dt', { key: row.provider + ':n', className: 'dcc-prov' + (first ? ' dcc-prov-first' : '') }, name))
          cells.push(h('dd', { key: row.provider + ':v', className: 'dcc-prov-val' + (first ? ' dcc-prov-first' : '') },
            row.error || '不可用'))
          first = false
          return
        }
        cells.push(h('dt', {
          key: row.provider + ':n',
          className: 'dcc-prov' + (first ? ' dcc-prov-first' : ''),
          title: (row.expiring || 0) > 0
            ? '15 天内到期 ' + fmtCredit(row.expiring) + '，其余 ' + fmtCredit(row.permanent || 0) + ' 长期有效'
            : '无 15 天内到期额度',
        }, active2 ? name + '（当前）' : name))
        cells.push(h('dd', {
          key: row.provider + ':v',
          className: 'dcc-prov-val' + (first ? ' dcc-prov-first' : ''),
        }, fmt(row.total) + ' ' + row.unit))

        var accounts = row.accounts || []
        for (var i = 0; i < accounts.length; i++) {
          var acc = accounts[i]
          var label = acc.nickname || acc.id || '账号'
          cells.push(h('dt', {
            key: row.provider + ':a' + i + ':n',
            className: 'dcc-acc',
            title: acc.error
              ? acc.error
              : (acc.expiring || 0) > 0
                ? '15 天内到期 ' + fmtCredit(acc.expiring) + '，其余 ' + fmtCredit(acc.permanent || 0) + ' 长期有效'
                : '无 15 天内到期额度',
          }, label))
          cells.push(h('dd', {
            key: row.provider + ':a' + i + ':v',
            className: 'dcc-acc-val',
          }, acc.error ? acc.error : fmtCredit(acc.total)))
        }
        first = false
      })
      nodes.push(h('dl', { key: 'grid', className: 'dcc-grid' }, cells))

      if ((snap.expiring || 0) > 0) {
        nodes.push(h('div', { key: 'exp', className: 'dcc-panel-rule', style: { marginTop: '10px', marginBottom: '8px' } }))
        nodes.push(h('div', {
          key: 'exp-text',
          className: 'dcc-panel-title',
          style: { fontSize: '11px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)', marginBottom: '0' },
        }, [
          h('span', { key: 'l' }, '15 天内到期'),
          h('span', { key: 'v', className: 'dcc-panel-title-value' }, fmtCredit(snap.expiring)),
        ]))
      }

      var foot = []
      if (lastTurn && lastTurn.delta > 0) {
        var who = accountWhoText(lastTurn.accounts)
        foot.push(h('span', { key: 'last' },
          '上一轮 −' + fmt(lastTurn.delta, 2) + ' ' + (lastTurn.unit || '积分') + (who ? ' · ' + who : '')))
      } else {
        foot.push(h('span', { key: 'ts' }, '读数 ' + timeText(snap.at)))
      }
      foot.push(h('button', {
        key: 'refresh',
        type: 'button',
        className: 'dcc-refresh',
        disabled: loading ? true : undefined,
        onClick: onRefresh,
      }, loading ? '刷新中…' : '刷新'))

      nodes.push(h('div', { key: 'foot', className: 'dcc-foot' }, foot))
      return nodes
    }

    function CreditsDock(props) {
      var rpc = props.creditRpc
      var snap = useStore()
      var active = useActiveProvider(props.useProjection)
      var lastTurn = useLastTurn()

      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      var anchorRef = useRef(null)
      var panelRef = useRef(null)
      var pos = usePanelPlacement(open, anchorRef, panelRef)

      useEffect(function () { ensurePoller(rpc) }, [rpc])
      useDismiss(open, setOpen, anchorRef, panelRef)

      var onRefresh = useCallback(function () {
        if (!rpc) return
        refresh(true, rpc).catch(function () { /* keep last */ })
      }, [rpc])

      if (snap.status === 'idle') return null
      if (snap.status === 'empty') return null
      if (snap.status === 'error' && snap.rows.length === 0) return null

      // 当前模型挂在某个渠道上时优先显示那个渠道，否则显示全部合计
      var row = activeRowOf(snap, active)
      var total = row ? row.total : snap.total
      var unit = row ? row.unit : snap.unit
      var loading = snap.status === 'loading'
      var head = row ? (providerIdLabel(row.provider) + ' ') : ''

      var children = [
        h('button', {
          key: 'btn',
          type: 'button',
          className: 'dcc-pill',
          'data-loading': loading ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          title: open ? '' : head + '剩余 ' + fmt(total) + ' ' + unit + ' · 点击看明细',
          onClick: function () { setOpen(!open) },
        }, [
          h('span', { key: 'dot', className: 'dcc-dot' }),
          h('span', { key: 'text' }, head + '剩余 ' + fmt(total) + ' ' + unit),
        ]),
      ]

      if (open) {
        var panel = h('div', {
          key: 'panel',
          ref: panelRef,
          className: 'dcc-panel',
          role: 'dialog',
          'aria-label': '渠道积分明细',
          style: pos
            ? { left: pos.left + 'px', top: pos.top + 'px' }
            : { left: '0px', top: '0px', visibility: 'hidden' },
        }, panelContent(snap, active, loading, lastTurn, onRefresh))

        if (createPortal && typeof document !== 'undefined' && document.body) {
          children.push(createPortal(panel, document.body))
        } else {
          children.push(panel)
        }
      }

      return h('span', { ref: anchorRef, className: 'dcc-anchor' }, children)
    }

    /* --------------------------------------------------------- 每轮消耗回填 */

    var TURN_PREFIX = 'dcc:v1:turn:'

    function storageKey(sessionId, turnKey) {
      return TURN_PREFIX + String(sessionId || '-') + ':' + String(turnKey)
    }

    function readStoredDelta(sessionId, turnKey) {
      try {
        var raw = window.localStorage.getItem(storageKey(sessionId, turnKey))
        if (!raw) return null
        var parsed = JSON.parse(raw)
        if (parsed && typeof parsed.delta === 'number' && isFinite(parsed.delta) && parsed.delta >= 0) return parsed
      } catch (e) { /* ignore */ }
      return null
    }

    function writeStoredDelta(sessionId, turnKey, delta, accounts, unit) {
      try {
        window.localStorage.setItem(
          storageKey(sessionId, turnKey),
          JSON.stringify({ delta: delta, accounts: accounts || [], unit: unit || '积分', at: Date.now() })
        )
      } catch (e) { /* ignore */ }
    }

    function turnKeyOf(turn) {
      if (typeof turn === 'number' && isFinite(turn)) return turn
      if (typeof turn === 'string') return turn
      if (turn && typeof turn === 'object') {
        if (typeof turn.index === 'number') return turn.index
        if (typeof turn.seq === 'number') return turn.seq
        if (typeof turn.id === 'string') return turn.id
        if (typeof turn.turn === 'number') return turn.turn
      }
      return null
    }

    var maxTurnSeen = new Map()     // sessionId -> 最新回合号
    var sessionPending = new Map()  // sessionId -> { turnKey, cancel }

    // 同一会话只允许「最新一轮」认领差量；回合连发时旧的让位，避免同一笔扣减被算两次
    function claimSettlement(sessionId, turnKey) {
      var current = sessionPending.get(sessionId)
      if (current) {
        if (typeof current.turnKey === 'number' && typeof turnKey === 'number' && current.turnKey > turnKey) {
          return null
        }
        current.cancel()
      }
      var entry = { turnKey: turnKey, cancelled: false }
      entry.cancel = function () { entry.cancelled = true }
      sessionPending.set(sessionId, entry)
      return entry
    }

    function releaseSettlement(sessionId, entry) {
      if (sessionPending.get(sessionId) === entry) sessionPending.delete(sessionId)
    }

    function turnTitle(stored) {
      var lines = ['本轮消耗（余额差量实测，上游扣账延迟 60~100 秒）']
      var accounts = stored.accounts || []
      accounts.forEach(function (acc) {
        lines.push('  · ' + (acc.nickname || acc.id || '账号') + '  −' + fmtCredit(acc.delta))
      })
      if (accounts.length > 1) lines.push('  合计 −' + fmtCredit(stored.delta))
      return lines.join('\n')
    }

    function TurnCost(props) {
      var rpc = props.creditRpc
      var sessionId = props.sessionId
      var turnKey = turnKeyOf(props.turn)

      var storedState = useState(function () {
        return turnKey === null ? null : readStoredDelta(sessionId, turnKey)
      })
      var stored = storedState[0]
      var setStored = storedState[1]

      var pendingState = useState(false)
      var pending = pendingState[0]
      var setPending = pendingState[1]

      useEffect(function () {
        if (!rpc || turnKey === null) return
        var existing = readStoredDelta(sessionId, turnKey)
        if (existing) { setStored(existing); return }

        var numeric = typeof turnKey === 'number'
        if (numeric) {
          var newest = maxTurnSeen.get(sessionId)
          if (newest !== undefined && turnKey < newest) return   // 历史回合不结算
          maxTurnSeen.set(sessionId, turnKey)
        }

        var cancelled = false
        var done = false
        var timers = []
        var base = null
        var entry = null

        function alive() { return !cancelled && !done && entry !== null && entry.cancelled !== true }

        function finish(result) {
          if (cancelled || done) return
          done = true
          if (entry) { entry.cancelled = true; releaseSettlement(sessionId, entry) }
          timers.forEach(function (t) { clearTimeout(t) })
          setPending(false)

          var delta = result && result.delta > 0 ? Math.round(result.delta * 100) / 100 : 0
          var accounts = (result && result.accounts ? result.accounts : []).map(function (acc) {
            return {
              id: acc.id,
              nickname: acc.nickname || '',
              provider: acc.provider,
              delta: Math.round(acc.delta * 100) / 100,
            }
          })
          var unit = store.unit || '积分'

          writeStoredDelta(sessionId, turnKey, delta, accounts, unit)   // 记 0 也是记账，避免重复结算
          var record = { delta: delta, accounts: accounts, unit: unit, at: Date.now() }
          setStored(record)
          if (delta > 0) {
            publishLastTurn({
              delta: delta,
              accounts: accounts,
              unit: unit,
              at: record.at,
              sessionId: sessionId,
              turnKey: turnKey,
            })
          }
        }

        function trySettle(isLast) {
          if (!alive() || base === null) return
          refresh(true, rpc, true)
            .then(function (snap) {
              if (!alive() || !snap || snap.status !== 'ready') return
              var diff = diffAccounts(base, accountTotalsOf(snap))
              if (diff.delta > EPS) finish(diff)
              else if (isLast) finish(null)
            })
            .catch(function () {
              if (isLast && alive()) finish(null)
            })
        }

        // 同一会话里所有 turnTail 会一起挂载，先让它们把 maxTurnSeen 报上来，再决定谁结算
        var kick = setTimeout(function () {
          if (cancelled || done) return
          if (numeric && maxTurnSeen.get(sessionId) !== turnKey) return
          entry = claimSettlement(sessionId, turnKey)
          if (entry === null) return
          // 回合刚结束时余额还没回落（上游扣账延迟 60~100s），此刻的读数就是本轮基线
          refresh(true, rpc, true)
            .then(function (snap) {
              if (!alive() || !snap || snap.status !== 'ready') return
              base = accountTotalsOf(snap)
              setPending(true)
              SETTLE_ATTEMPTS.forEach(function (delay, index) {
                timers.push(setTimeout(function () {
                  trySettle(index === SETTLE_ATTEMPTS.length - 1)
                }, delay))
              })
            })
            .catch(function () { /* nothing to show */ })
        }, CLAIM_DELAY_MS)
        timers.push(kick)

        return function () {
          cancelled = true
          timers.forEach(function (t) { clearTimeout(t) })
          if (entry) releaseSettlement(sessionId, entry)
        }
      }, [rpc, sessionId, turnKey])

      if (turnKey === null) return null

      if (stored) {
        if (!(stored.delta > 0)) return null
        var who = accountWhoText(stored.accounts)
        return h('span', {
          className: 'dcc-turn',
          title: turnTitle(stored),
        }, [
          h('span', { key: 'd' }, '本轮 −' + fmt(stored.delta, 2) + ' ' + (stored.unit || '积分')),
          who ? h('span', { key: 'who', className: 'dcc-turn-who' }, '· ' + who) : null,
        ])
      }

      if (!pending) return null
      return h('span', {
        className: 'dcc-turn',
        'data-pending': 'true',
        title: '上游约 60~100 秒后落账，正在回填',
      }, [h('span', { key: 'p' }, '本轮 结算中…')])
    }

    /* ---------------------------------------------------------------- 装配 */

    function installCss(ctx) {
      var run = function () {
        var el = document.createElement('style')
        el.setAttribute('data-dsh-channel-credits', '')
        el.textContent = CSS
        document.head.appendChild(el)
        return function () { try { el.remove() } catch (e) { /* ignore */ } }
      }
      if (ctx && typeof ctx.effect === 'function') {
        try { ctx.effect(run, 'channel-credits: styles'); return } catch (e) { /* fall through */ }
      }
      run()
    }

    var inject = ['slots']

    function apply(ctx) {
      var rpc = makeRpc(ctx)
      installCss(ctx)
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'channel-credits-dock',
          order: 200,
          label: '渠道积分',
          inject: function () { return { creditRpc: rpc } },
        }, CreditsDock)
      })
      ctx.slots.inject('conversation.chat.turnTail', function () {
        return ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'channel-credits-turn',
          order: 20,
          label: '本轮积分',
          inject: function () { return { creditRpc: rpc } },
        }, TurnCost)
      })
    }

    return { name: 'channel-credits', inject: inject, apply: apply }
  },
})
