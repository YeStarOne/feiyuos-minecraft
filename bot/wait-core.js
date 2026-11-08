// wait-core.js — /wait 契约 wait/1.1 Node 实现（2026-11-08，v1.1：/inv/count 末段缺失按 0 求值）
// 契约真源：bot/contract/CONTRACT.md；Python 参考实现：bot/contract/wait_probe.py
// 两个用途：① bot.js 生产挂载（runWait/makeHttpHandler，时间驱动，probeFn 由挂载方注入）
//           ② run_cases.js fixture 跑测器（runCase，采样预算驱动，与 Python run_case 同构）
// 同一份 fixture 两边都绿才算契约成立。改契约流程：先改 CONTRACT → 加用例 → 两边实现都红 → 再改实现。
const CONTRACT_NAME = 'wait/1.1'
const WAITABLE = { '/state': true, '/pos': true, '/inv/count': true, '/time': true, '/health': true }
const MAX_EXPR = 128        // 整条条件表达式字符上限（§3）
const MAX_SEG = 8           // 路径段数上限
const MAX_IDENT = 64        // 单段标识符上限（1333 个物品 id 最长也要塞得下）
const MAX_TIMEOUT = 300     // >300 夹到 300；≤0 或非整数 → request_shape
const DEFAULT_TIMEOUT = 60
const MIN_POLL = 0.5
const MAX_POLL = 2.0
const DEFAULT_POLL = 1.0
const DEMO_ITEM_IDS = ['iron_ingot', 'coal', 'stick', 'oak_log'] // fixture 无 known_fields 时的静态 schema 兜底
// v1.1 MAP_DEFAULT：/inv/count 末段缺失按 0 求值（"等到包里没某样东西"要能成立）；
// 静态 schema 预检只决定要不要 400，不改变求值；中间段缺失仍是 missing
const MAP_DEFAULT = { '/inv/count': 0 }
const WAIT_LIMIT = 32       // 并发 waiter 上限（实现层细节，契约不管）
let waitActive = 0          // 当前并发 waiter 数（429 判据）

// MUT 只在 --mutation-check（阳性对照）时非 null；生产路径恒为 null
let MUT = null

class Bad extends Error {
  constructor(detail) { super(detail); this.detail = detail }
}
class TypeErr_ extends Error {}

// ---- 语法（§3）----
// §10 绝对结尾：JS 的 $ 也会匹配"结尾换行前"，单靠 $ 会放过 "a == 1\n"。
// 解法：正则后必须校验 m[0].length === expr.length（吃满整条才算合法）。
const PATH_SRC = '[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*'
const EXPR_RE = new RegExp('^(' + PATH_SRC + ') (==|!=|<=|>=|<|>) (.+)$')
// dollar_anchor 变异体专用：JS 的 $（无 /m）只匹配绝对结尾，天然拒结尾换行——
// 与 Python 的 $（也匹配结尾换行前）语义不同。要忠实模拟 Python 的 $ 坑，用 /m 版。
const EXPR_RE_DOLLAR = new RegExp('^(' + PATH_SRC + ') (==|!=|<=|>=|<|>) (.+)$', 'm')
const IDENT_RE = /^[A-Za-z0-9_]{1,64}$/
const NUM_RE = /^-?[0-9]+(\.[0-9]+)?$/   // §10：写死 [0-9] 不用 \d（防全角数字）
// unicode_digit 变异体专用：JS 的 \d 天生只认 ASCII（与 [0-9] 等价），要忠实模拟
// Python 的 \d（Unicode Nd 类，吃全角）行为，用 \p{Nd}。模拟出的实现会把 ３６
// 放行进字面量（Number('３⑥') 为 NaN，后续比较炸成 type_error）→ gn_fullwidth_digit 必红。
const NUM_RE_UNICODE = /^-?[\p{Nd}]+(\.[\p{Nd}]+)?$/u
const STR_RE = /^"[^"\\\n]{0,64}"$/      // 无转义、不可含引号、不可跨行

function parseLiteral(s) {
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null') return null
  if (NUM_RE.test(s) || (MUT === 'unicode_digit' && NUM_RE_UNICODE.test(s))) return Number(s)
  if (STR_RE.test(s)) return s.slice(1, -1)
  throw new Bad('condition_literal')
}

function parseCondition(expr) {
  if (MUT === 'strip' && typeof expr === 'string') expr = expr.replace(/\s+/g, ' ').trim()
  if (typeof expr !== 'string' || expr === '') throw new Bad('condition_grammar')
  if (expr.length > MAX_EXPR) throw new Bad('expr_len')      // 顺序：expr_len 在 grammar 之前（129 字符报 expr_len）
  const m = (MUT === 'dollar_anchor' ? EXPR_RE_DOLLAR : EXPR_RE).exec(expr)
  if (!m || (MUT !== 'dollar_anchor' && m[0].length !== expr.length)) throw new Bad('condition_grammar')
  const segs = m[1].split('.')
  if (segs.length > MAX_SEG) throw new Bad('path_segments')
  for (const s of segs) if (!IDENT_RE.test(s)) throw new Bad('path_ident_len')
  return { segs, op: m[2], lit: parseLiteral(m[3]) }
}

// ---- 路径解析（§4：纯字典下钻）----
// 往标量/数组里下钻 → type_error；键不存在 → missing。resolved null 是合法值。
function resolve(payload, segs) {
  let cur = payload
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return ['type_error', undefined]
    if (!Object.hasOwn(cur, s)) return ['missing', undefined]
    cur = cur[s]
  }
  return ['ok', cur]
}

function isNum(v) { return typeof v === 'number' }

// ---- 比较语义（§5：绝不隐式转换）----
// 排序只对数字开放；bool 只和 bool 比（true==1 两边语言都会"顺手"给真，必须显式拦）。
function compare(op, value, literal) {
  if (op === '<' || op === '<=' || op === '>' || op === '>=') {
    if (!(isNum(value) && isNum(literal))) throw new TypeErr_()
    if (op === '<') return value < literal
    if (op === '<=') return value <= literal
    if (op === '>') return value > literal
    return value >= literal
  }
  if (MUT === 'no_coercion') return op === '==' ? String(value) === String(literal) : String(value) !== String(literal)
  let eq
  if (isNum(value) && isNum(literal)) eq = value === literal
  else if (typeof value === 'string' && typeof literal === 'string') eq = value === literal
  else if (typeof value === 'boolean' && typeof literal === 'boolean') eq = value === literal
  else if (value === null && literal === null) eq = true
  else throw new TypeErr_()   // 含 true==1、"36"==36、null==36
  return op === '==' ? eq : !eq
}

function evaluate(payload, segs, op, lit, defaultVal) {
  const [st, val] = resolve(payload, segs)
  if (st !== 'ok') {
    if (st === 'missing' && defaultVal !== undefined && MUT !== 'no_map_default') {
      try { return compare(op, defaultVal, lit) ? 'true' : 'false' } catch (e) { if (e instanceof TypeErr_) return 'type_error'; throw e }
    }
    return st
  }
  if (MUT === 'zero_as_missing' && val === 0) return 'missing'
  try {
    return compare(op, val, lit) ? 'true' : 'false'
  } catch (e) {
    if (e instanceof TypeErr_) return 'type_error'
    throw e
  }
}

// ---- 请求校验（§6：detail 九步定序，第一个失败的即为答案）----
function validate(req, schema) {
  const path = req.path
  const tmo = req.timeout_s
  if (typeof path !== 'string' || !WAITABLE[path]) {
    if (!(MUT === 'allowlist_wide' && typeof path === 'string' && path.startsWith('/'))) {
      throw new Bad('path_not_waitable')
    }
  }
  if (!('condition' in req) || typeof req.condition !== 'string') throw new Bad('request_shape')
  let eff = DEFAULT_TIMEOUT
  if (tmo != null) {
    if (typeof tmo === 'boolean' || typeof tmo !== 'number' || !Number.isInteger(tmo) || tmo <= 0) {
      throw new Bad('request_shape')
    }
    eff = Math.min(tmo, MAX_TIMEOUT)
  }
  const { segs, op, lit } = parseCondition(req.condition)
  // §7 静态 schema 预检：只对 /inv/count。判笔误靠 schema（1333 物品名），不靠当前快照
  // ——「名字写错」和「该物品现在是 0 个」在快照里长得一样。
  if (path === '/inv/count' && MUT !== 'no_schema') {
    const pool = (schema && schema['/inv/count']) || DEMO_ITEM_IDS
    const has = pool instanceof Set ? pool.has(segs[0]) : pool.includes(segs[0])
    if (!has) { const e = new Bad('unknown_field'); e.seg0 = segs[0]; throw e }
  }
  return { path, segs, op, lit, eff }
}

// ---- 响应体（§8 响应字段；fixture 模式 elapsed_ms=0）----
function resp(req, reason, detail, matched, value, matchedAt, total, ok, failed, miss, terr, eff, elapsedMs) {
  return {
    contract: CONTRACT_NAME,
    ok: !!matched,
    reason,
    detail: detail || '',
    matched: !!matched,
    path: req && req.path,
    condition: req && req.condition,
    effective_timeout_s: eff,
    elapsed_ms: elapsedMs,
    samples_total: total,
    samples_ok: ok,
    samples_failed: failed,
    samples_missing: miss,
    samples_type_error: terr,
    matched_at_sample: matchedAt === undefined ? null : matchedAt,
    value: value === undefined ? null : value,
  }
}

// 编辑距离（Levenshtein，滚动数组；只给 hint 用，规模 1333×短串）
function editDistance(a, b) {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}
// hint 约束（tablet-pet）：只做附加信息、绝不改 reason/detail；不整表倒出——
// 与输入编辑距离最近的 5 个（≤8）。1333 全塞会变几十 KB。
function nearestNames(pool, input, k) {
  const names = pool instanceof Set ? Array.from(pool) : pool
  const scored = names.map((nm) => [editDistance(String(input), nm), nm])
  scored.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : 1))
  return scored.slice(0, k).map((x) => x[1])
}
const pushRecent = (recent, tag) => { recent.push(tag); if (recent.length > 3) recent.shift() }

// ---- fixture 跑测（与 Python run_case 同构；timeout_s 不决定采样次数，max_samples 才决定）----
function runCase(c) {
  const req = { path: c.path, condition: c.condition, timeout_s: c.timeout_s }
  const schema = c.known_fields ? { '/inv/count': c.known_fields } : null
  let v
  try {
    v = validate(req, schema)
  } catch (e) {
    if (e instanceof Bad) {
      const tmo = c.timeout_s
      const eff = (typeof tmo === 'number' && Number.isInteger(tmo) && tmo > 0) ? Math.min(tmo, MAX_TIMEOUT) : 0
      return resp(req, 'bad_request', e.detail, false, null, null, 0, 0, 0, 0, 0, eff, 0)
    }
    throw e
  }
  const snap = Array.isArray(c.snapshot) ? c.snapshot : []
  const maxN = (c.max_samples != null ? c.max_samples : 0) || snap.length || 1
  let ok = 0, failed = 0, miss = 0, terr = 0, matchedAt = null, lastValue = null
  const recent = []
  for (let i = 0; i < maxN; i++) {
    const el = snap.length ? snap[Math.min(i, snap.length - 1)] : { __error: 'empty snapshot' }
    const isDict = el && typeof el === 'object' && !Array.isArray(el)
    if (isDict && Object.hasOwn(el, '__error')) {          // 这次拿不到 payload
      failed++; pushRecent(recent, 'failed'); continue
    }
    let payload = el
    if (c.payload_of != null) {                            // fixture 的 payload_of 是键名（挂载参数）
      if (isDict && Object.hasOwn(el, c.payload_of)) payload = el[c.payload_of]
      else { failed++; pushRecent(recent, 'failed'); continue }  // 挂载点解不出 payload == payload 拿不到
    }
    ok++; lastValue = payload
    const verdict = evaluate(payload, v.segs, v.op, v.lit, v.path === '/inv/count' && v.segs.length === 1 ? MAP_DEFAULT['/inv/count'] : undefined)
    if (verdict === 'missing') miss++
    else if (verdict === 'type_error') terr++
    pushRecent(recent, 'ok')
    if (verdict === 'true') { matchedAt = i + 1; break }   // 命中立刻返回
  }
  const reason = finishReason(ok, failed, matchedAt, recent)
  return resp(req, reason, '', reason === 'matched', lastValue, matchedAt, ok + failed, ok, failed, miss, terr, v.eff, 0)
}

// ---- 判定优先级（§9：bad_request > degraded > matched > timeout）----
// R3: failed/total > 0.5（严格，0.5 不算）；R4: 命中但含命中样本在内的近 3 样本 ≥2 failed → degraded
function finishReason(ok, failed, matchedAt, recent) {
  const total = ok + failed
  const ratioGate = MUT === 'ratio_ge' ? (f, t) => f / t >= 0.5 : (f, t) => f / t > 0.5
  const deg = total > 0 && ratioGate(failed, total)
  if (matchedAt != null) {
    const rDeg = deg || recent.filter((x) => x === 'failed').length >= 2
    return rDeg ? 'degraded' : 'matched'
  }
  return deg ? 'degraded' : 'timeout'
}

// ---- 生产等待循环（时间驱动；t=0 立刻采一次，之后每 poll 采一次，命中立刻返回）----
async function runWait(req, deps) {
  req = req || {}
  const probeFn = deps.probeFn
  const payloadOf = deps.payloadOf || ((b) => b)
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now || Date.now
  const isAborted = deps.isAborted || (() => false)
  const schema = deps.schema || null
  if (waitActive >= WAIT_LIMIT) {
    return { status: 429, body: { contract: CONTRACT_NAME, ok: false, reason: 'too_many_waiters', detail: '', current: waitActive, limit: WAIT_LIMIT } }
  }
  const pollRaw = Number(req.poll_s != null ? req.poll_s : req.interval_s)
  const pollS = Math.min(Math.max(Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : DEFAULT_POLL, MIN_POLL), MAX_POLL)
  let v
  try {
    v = validate(req, schema)
  } catch (e) {
    if (e instanceof Bad) {
      const tmo = req.timeout_s
      const eff = (typeof tmo === 'number' && Number.isInteger(tmo) && tmo > 0) ? Math.min(tmo, MAX_TIMEOUT) : 0
      const body = resp(req, 'bad_request', e.detail, false, null, null, 0, 0, 0, 0, 0, eff, 0)
      // hint 只在附加信息区：不改 reason/detail；最近 5 个（≤8），不整表倒出
      if (e.detail === 'unknown_field' && schema && schema['/inv/count']) {
        body.hint = { nearest_names: nearestNames(schema['/inv/count'], e.seg0 || '', 5) }
      }
      return { status: 400, body }
    }
    throw e
  }
  waitActive++
  const t0 = now()
  let ok = 0, failed = 0, miss = 0, terr = 0, matchedAt = null, lastValue = null, sampleNo = 0
  const recent = []
  try {
    for (;;) {
      if (isAborted()) return { status: 0, body: null }   // 客户端断开：停止采样、不写响应
      sampleNo++
      const p = probeFn(v.path)
      if (p && p.status === 200) {
        let payload
        try { payload = payloadOf(p.body) } catch { payload = undefined }
        if (payload !== undefined) {
          ok++; lastValue = payload
          const verdict = evaluate(payload, v.segs, v.op, v.lit, v.path === '/inv/count' && v.segs.length === 1 ? MAP_DEFAULT['/inv/count'] : undefined)
          if (verdict === 'missing') miss++
          else if (verdict === 'type_error') terr++
          pushRecent(recent, 'ok')
          if (verdict === 'true') { matchedAt = sampleNo; break }   // R2：命中立即停止采样
        } else { failed++; pushRecent(recent, 'failed') }
      } else {
        failed++; pushRecent(recent, 'failed')
      }
      const elapsed = now() - t0
      if (elapsed >= v.eff * 1000) break
      const remain = v.eff * 1000 - elapsed
      await sleep(Math.min(pollS * 1000, Math.max(100, remain)))
    }
  } finally {
    waitActive--
  }
  const reason = finishReason(ok, failed, matchedAt, recent)
  return { status: 200, body: resp(req, reason, '', reason === 'matched', lastValue, matchedAt, ok + failed, ok, failed, miss, terr, v.eff, now() - t0) }
}

// ---- HTTP 适配（bot.js 用）：probeFn/payloadOf/schema 由挂载方注入 ----
function makeHttpHandler(deps) {
  return async function handleHttp(req, res, body) {
    let aborted = false
    res.on('close', () => { if (!res.writableEnded) aborted = true })
    const r = await runWait(body || {}, deps)
    if (aborted || r.status === 0) return   // 断开的不写一个必然失败的响应
    const reason = r.body && r.body.reason
    const code = reason === 'bad_request' ? 400 : reason === 'too_many_waiters' ? 429 : 200
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(r.body))
  }
}

module.exports = {
  CONTRACT_NAME, WAITABLE, MAX_EXPR, MAX_SEG, MAX_IDENT, MAX_TIMEOUT, DEFAULT_TIMEOUT,
  runWait, runCase, finishReason, makeHttpHandler,
  _setMutation: (m) => { MUT = m },   // 只给 run_cases.js --mutation-check 用
}
