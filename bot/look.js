// look.js — MC 视觉捕获适配器（视觉闭环的"出帧"那一半）
//
// 职责边界（2026-11-08 与 OS 主持/tablet-pet 对齐）：
//   我 = 捕获适配器：mineflayer 第一人称 → prismarine-viewer（浏览器 WebGL）→ 无头 Chrome 截图 → JPEG 落盘
//   理解 = eye-server（tablet-pet 的 scene 三分区），我只 POST 帧 + meta.app_type="mc"，收 desc/reason
//
// 硬约束（主人拍板）：
//   - 每请求 ≤3 帧、宽 ≤800、JPEG（quality 80）
//   - 限频 ≤1 次/2s，≤200 次/天（跨重启持久化）——VLM 是贵操作，走路不用它
//   - 不在动作串行队列里同步等：/look 不走 runAction，VLM 慢就慢，不堵她挖方块
//   - 截图必须落盘到可浏览目录（主人和主持都能翻"她当时看到了什么"）
//   - 失败必须显式降级：source 三值 capture_only / fallback_state / vision，绝不假装看见了
const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer-core')
const { Vec3 } = require('vec3')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SHOTS_DIR = path.join(__dirname, '..', 'shots')
const USAGE_FILE = path.join(__dirname, 'state', 'look-usage.json')
const VIEWER_URL = 'http://127.0.0.1:3010'    // 第一人称（=她的眼睛）
const VIEWER_URL_3P = 'http://127.0.0.1:3011' // 第三人称（orbit 环绕，看建筑/验收）

const MIN_INTERVAL_MS = 2000
const DAILY_LIMIT = 200
const MAX_FRAMES = 3
const MAX_WIDTH = 800
// 第一人称取景：人不会怼着墙看，会先自己退半步（主人 2026-11-08）
const BACK_CLEAR_DIST = 2.5   // 眼里最近的方块至少要有这么远，画面才不是一堵墙
const BACK_TRIGGER_DIST = 2.0 // 近于这个距离才值得动（远处有山有树不叫贴脸）
const BACK_MAX_BLOCKS = 3
const MAX_FRAME_BYTES = 800 * 1024
const VISION_TIMEOUT_MS = 35000   // eye-server 实测 4~30s（冷启动/排队时会顶到 20s+，别卡太紧）
const TOKEN_FILE = process.env.EYE_TOKEN_FILE || path.join(__dirname, '..', 'ops', '.eye-mc-token')

/** token 来源：EYE_TOKEN 环境变量优先，其次 token 文件（tablet-pet 会建，一行文本） */
function readToken() {
  if (process.env.EYE_TOKEN) return process.env.EYE_TOKEN.trim()
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null } catch (_) { return null }
}

function loadUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
    if (typeof u.day === 'string' && typeof u.count === 'number') return u
  } catch (_) {}
  return { day: today(), count: 0 }
}
function today() { return new Date().toISOString().slice(0, 10) }
function saveUsage(u) {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true })
  const tmp = `${USAGE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(u))
  fs.renameSync(tmp, USAGE_FILE)
}

function createLooker({ getBot, snapshot, log = () => {}, canMove = () => true }) {
  let usage = loadUsage()
  let lastAt = 0
  let inflight = false
  let browser = null
  const pages = {}    // mode -> page
  const camState = {} // mode -> {theta, phi, radius}：OrbitControls 的相机姿态，必须自己记账
  let launching = null

  const urlOf = (mode) => (mode === 'third' ? VIEWER_URL_3P : VIEWER_URL)
  const VIEW_H = 600

  function initCam(mode) {
    // 前端起始相机 = botPos + (0,20,20)：theta=0(+Z)、phi=45°、r=28.28
    camState[mode] = { theta: 0, phi: Math.PI / 4, radius: Math.hypot(20, 20) }
  }

  /** OrbitControls：theta -= 2π·dx/h，phi -= 2π·dy/h（h=DOM 高），所以反解位移即可精确打角 */
  async function dragCam(pg, dTheta, dPhi) {
    const h = VIEW_H
    const dx = Math.round(-dTheta * h / (2 * Math.PI))
    const dy = Math.round(-dPhi * h / (2 * Math.PI))
    if (!dx && !dy) return
    await pg.mouse.move(400, 300)
    await pg.mouse.down()
    await pg.mouse.move(400 + dx, 300 + dy, { steps: 12 })
    await pg.mouse.up()
    await new Promise((r) => setTimeout(r, 250))
  }

  /** 滚轮推拉：deltaY<0 = 靠近（每次半径 ×0.95） */
  async function dollyCam(pg, targetRadius) {
    const st = camState.third
    if (!st) return
    let n = Math.round(Math.log(targetRadius / st.radius) / Math.log(0.95))
    const dir = n < 0 ? 100 : -100
    for (let i = 0; i < Math.abs(n); i++) await pg.mouse.wheel({ deltaY: dir })
    st.radius = st.radius * Math.pow(0.95, Math.abs(n) * (dir < 0 ? 1 : -1))
  }

  const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }

  /** 相机埋进方块/贴着地面时，近平面会切开地面，透视到地下洞穴（主人 2026-11-08 诊断）。
   *  所以不能只查相机那一格：要查 3×3×3 邻域（含脚下那格地板），有实心就抬高俯角。
   *  抬不出去就保持原值并如实标注。 */
  function freePhi(bot, theta, phi, r) {
    const base = bot.entity && bot.entity.position
    if (!base) return { phi, buried: false }
    const blockedAt = (phi2) => {
      const p = {
        x: base.x + r * Math.sin(phi2) * Math.sin(theta),
        y: base.y + r * Math.cos(phi2),
        z: base.z + r * Math.sin(phi2) * Math.cos(theta),
      }
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -2; dy <= 0; dy++)          // dy=-2 覆盖"脚下那格地板"
          for (let dz = -1; dz <= 1; dz++) {
            const blk = bot.blockAt(new Vec3(bx + dx, by + dy, bz + dz))
            if (blk && blk.boundingBox === 'block') return true
          }
      return false
    }
    if (!blockedAt(phi)) return { phi, buried: false }
    for (let deg = (phi * 180) / Math.PI; deg >= 28; deg -= 5) {
      const p2 = (deg * Math.PI) / 180
      if (!blockedAt(p2)) return { phi: p2, buried: false, lifted: Math.round((phi * 180) / Math.PI - deg) }
    }
    return { phi, buried: true }
  }

  // ---- 第一人称"退半步"取景（主人：人都是稍微后退一点看，不怼着墙看）----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const isSolid = (b) => !!b && b.boundingBox === 'block'
  const HAZARD = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow', 'water', 'flowing_water'])

  const eyePos = (bot) => {
    const p = bot.entity.position
    return new Vec3(p.x, p.y + (bot.entity.height ? bot.entity.height * 0.9 : 1.62), p.z)
  }

  /** 视线正前方最近一块实心方块的距离（null = 视野开阔） */
  function frontBlocked(bot, maxDist) {
    let dist = Infinity, name = null
    try {
      const hit = bot.blockAtCursor ? bot.blockAtCursor(Math.ceil(maxDist) + 1) : null
      if (hit) {
        dist = eyePos(bot).distanceTo(hit.position.offset(0.5, 0.5, 0.5))
        name = hit.name
      }
    } catch (_) { /* 射线失败当没挡 */ }
    return { blocked: dist <= maxDist, dist: Number.isFinite(dist) ? Math.round(dist * 10) / 10 : null, name }
  }

  /** 这格脚下站不站得人：地板实心、身体两格净空、无危险物 */
  function unsafeStand(bot, feet) {
    const floor = bot.blockAt(feet.offset(0, -1, 0))
    const at = bot.blockAt(feet)
    const head = bot.blockAt(feet.offset(0, 1, 0))
    if (!floor && !at) return '区块没加载'
    if (!isSolid(floor)) return '脚下没有实心地板'
    if (isSolid(at)) return '目标格有 ' + (at && at.name)
    if (isSolid(head)) return '头顶有 ' + (head && head.name)
    for (const b of [floor, at, head]) if (b && HAZARD.has(b.name)) return '危险物 ' + b.name
    return null
  }

  /** 沿当前朝向挪一格：sign=+1 后退，-1 前进。逐格验算，中途脚下悬空立刻停 */
  async function nudge(bot, sign, blocks) {
    let moved = 0
    for (let i = 0; i < blocks; i++) {
      if (!bot.entity) return { moved, why: 'bot 掉了' }
      const p = bot.entity.position.clone()
      const yaw = bot.entity.yaw
      const dx = Math.sin(yaw) * sign, dz = -Math.cos(yaw) * sign   // 后退方向 = (sin yaw, -cos yaw)
      const feet = new Vec3(Math.floor(p.x + dx * 0.9), Math.floor(p.y + 0.1), Math.floor(p.z + dz * 0.9))
      const why = unsafeStand(bot, feet)
      if (why) return { moved, why }
      bot.setControlState(sign > 0 ? 'back' : 'forward', true)
      const t0 = Date.now()
      try {
        while (Date.now() - t0 < 1500) {
          await sleep(60)
          if (!bot.entity) return { moved, why: 'bot 掉了' }
          if (p.distanceTo(bot.entity.position) >= 0.8) break
          const under = bot.blockAt(bot.entity.position.offset(0, -0.6, 0))
          if (!isSolid(under)) return { moved, why: '脚下空了，立刻停' }
        }
      } finally {
        bot.setControlState('back', false)
        bot.setControlState('forward', false)
      }
      if (p.distanceTo(bot.entity.position) < 0.15) return { moved, why: '走不动（可能被卡住）' }
      moved++
    }
    return { moved, why: null }
  }

  /** 拍照前把机位让出来：贴脸(<2 格有实心)就按差值退几格（≤3）。返回 {moved,…}，拍完要用 undoNudge 走回来 */
  async function stepBackForView(bot) {
    const before = frontBlocked(bot, BACK_TRIGGER_DIST)
    const out = { attempted: false, triggerDist: before.dist, blocker: before.name, moved: 0, notes: [] }
    if (!before.blocked) { out.clear = true; out.clearDist = before.dist; return out }
    out.clear = false
    if (!bot.entity || !bot.entity.onGround) { out.notes.push('不在落地状态，不乱动'); return out }
    if (!canMove()) { out.notes.push('动作队列/作业在跑，/look 不抢身体，放弃后退'); return out }
    out.attempted = true
    const need = Math.min(BACK_MAX_BLOCKS, Math.ceil(BACK_CLEAR_DIST - (before.dist || 0)))
    for (let i = 0; i < need; i++) {
      const r = await nudge(bot, +1, 1)
      out.moved += r.moved
      if (r.why) { out.notes.push('后退中止：' + r.why); break }
    }
    const after = frontBlocked(bot, BACK_CLEAR_DIST - 0.2)
    out.clear = !after.blocked
    out.clearDist = after.dist
    return out
  }

  /** 拍完走回拍照前的位置（人在后退看完之后会走回来） */
  async function undoNudge(bot, moved) {
    const r = await nudge(bot, -1, moved)
    return { restored: !r.why && r.moved >= moved, why: r.why, moved: r.moved }
  }

  async function ensurePage(mode) {
    if (pages[mode] && browser && browser.connected) return pages[mode]
    if (launching) { await launching; if (pages[mode]) return pages[mode] }
    launching = (async () => {
      if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
          executablePath: CHROME,
          headless: 'new',
          args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
        })
      }
      const pg = await browser.newPage()
      pg.on('pageerror', (e) => log('[look] pageerror: ' + e.message))
      await pg.setViewport({ width: MAX_WIDTH, height: 600 })
      await pg.goto(urlOf(mode), { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 3500)) // 等 three.js 把 chunk 画出来
      pages[mode] = pg
      initCam(mode)
      log(`[look] ${mode} 取景器就绪 ${urlOf(mode)}`)
      return pg
    })()
    try { return await launching } finally { launching = null }
  }

  /** 取一张 JPEG buffer 并落盘，返回 {file, bytes, width, mode} */
  async function grab(mode, width, orbit, botYaw) {
    let camInfo = null
    const pg = await ensurePage(mode)
    const info = await pg.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return { canvas: false }
      const gl = c.getContext('webgl2') || c.getContext('webgl')
      return { canvas: true, webgl: !!gl, w: c.width, h: c.height }
    })
    if (!info.canvas || !info.webgl) throw new Error('viewer canvas 未就绪（WebGL 不可用或页面没加载完）')
    // 视口宽度决定输出宽度：直接改 viewport 比缩小图片质量好
    if (width !== MAX_WIDTH) await pg.setViewport({ width, height: Math.round(width * 0.75) })
    if (mode === 'third' && orbit) {
      const st = camState.third
      if (orbit.reset) {
        // 把取景器页面重新加载：相机回到 bot+(0,20,20)、记账清零（怀疑累计拖动导致姿态漂移时用）
        await pg.goto(urlOf(mode), { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise((r) => setTimeout(r, 3000))
        initCam(mode)
      }
      if (orbit.over) {
        // 越肩：相机站到角色正后方、略高于眼、离得近 → 角色居中、前方视野完整
        // Minecraft yaw：forward = (-sin yaw, 0, cos yaw)；OrbitControls 里 theta=0 在 +Z，
        // 要让相机落在 bot 背后 → theta_target = π - yaw
        const thetaTarget = norm(Math.PI - (Number(botYaw) || 0) + (Number(orbit.yawOffsetDeg) || 0) * Math.PI / 180)
        const phiWant = (Number(orbit.pitchDeg) || 78) * Math.PI / 180   // 90°=与眼同高
        const dist = Number(orbit.dist) || 4.5
        const f = freePhi(getBot(), thetaTarget, phiWant, dist)          // 别把相机埋进方块
        const phiTarget = f.phi
        camInfo = { liftedDeg: f.lifted || 0, buried: !!f.buried, phiDeg: Math.round((phiTarget * 180) / Math.PI) }
        if (f.buried) log('[look] 警告：机位仍在实心方块内（抬高也出不来），这一帧可能透视到地下')
        else if (f.lifted) log(`[look] 机位原本埋在方块里，俯角抬高 ${f.lifted}° 到 ${camInfo.phiDeg}°`)
        await dragCam(pg, norm(thetaTarget - st.theta), phiTarget - st.phi)
        st.theta = thetaTarget; st.phi = phiTarget
        await dollyCam(pg, dist)
        await new Promise((r) => setTimeout(r, 500))
      } else {
        const dTheta = (Number(orbit.yawDeg) || 0) * Math.PI / 180
        const dPhi = (Number(orbit.pitchDeg) || 0) * Math.PI / 180
        await dragCam(pg, dTheta, dPhi)
        st.theta = norm(st.theta + dTheta); st.phi = st.phi + dPhi
        if (orbit.zoom) {
          // 粗调：单次滚轮事件，正=拉远 负=靠近
          const n = Math.round(Number(orbit.zoom) / 100)
          for (let i = 0; i < Math.abs(n); i++) await pg.mouse.wheel({ deltaY: n > 0 ? 100 : -100 })
          st.radius = st.radius * Math.pow(0.95, n > 0 ? -Math.abs(n) : Math.abs(n))
          await new Promise((r) => setTimeout(r, 400))
        }
      }
    }
    // 直接从 canvas 取像素（而不是 page.screenshot）：拿到的就是 WebGL 帧本身，不经过合成层。
    // preserveDrawingBuffer=false 时偶发取到已清空的缓冲（黑帧，JPEG 很小），所以重试到够大为止。
    const grabCanvas = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const dataUrl = await pg.evaluate(() => new Promise((res) => {
          const c = document.querySelector('canvas')
          if (!c) return res(null)
          requestAnimationFrame(() => requestAnimationFrame(() => {
            try {
              const gl = c.getContext('webgl2') || c.getContext('webgl')
              if (gl) gl.finish()   // 等 swiftshader 把这一帧画完
              res(c.toDataURL('image/jpeg', 0.8))
            } catch (e) { res(null) }
          }))
        }))
        if (dataUrl && dataUrl.startsWith('data:image/jpeg;base64,')) {
          const b = Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')
          if (b.length > 20000) return b      // 黑帧/空帧的 JPEG 很小，20KB 是安全下限
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      return null
    }

    let buf = await grabCanvas()
    if (!buf) {
      log('[look] canvas 取像素失败，退回页面截图')
      const vh = Math.round(width * 0.75)
      await pg.setViewport({ width, height: vh })
      await new Promise((r) => setTimeout(r, 350))
      buf = await pg.screenshot({ type: 'jpeg', quality: 80 })
    }
    fs.mkdirSync(SHOTS_DIR, { recursive: true })
    const shot = mode === 'third' ? (orbit && orbit.over ? 'over' : '3p') : 'look'
    const file = path.join(SHOTS_DIR, `${shot}-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}.jpg`)
    fs.writeFileSync(file, buf)
    return { file, bytes: buf.length, width, mode, camera: camInfo }
  }

  /** 视觉理解：有配置才调；没配置就诚实地报 capture_only
   *  契约（feiyu-os #84 code/eyes/frames-contract.md，已冻结）：
   *    请求 POST {EYE_SERVER}/frames  body {frames:[base64...], meta:{app_type:"mc"}}
   *         头 X-Scene: mc + Authorization: Bearer <eye-server.mc.token>
   *    响应只有两种 {ok:true,desc} | {ok:false,reason:"unreadable|too-dark|no-frame"}，没有 SKIP
   *    限制 ≤3 帧/请求、单帧 ≤800KB JPEG、≤1 请求/2s、日上限 200 */
  async function understand(frames, prompt) {
    const url = process.env.EYE_SERVER
    const token = readToken()
    if (!url || !token) {
      return { source: 'capture_only', description: null, reason: 'eye-server 未配置（EYE_SERVER 或 token 缺失）' }
    }
    const oversize = frames.filter((f) => f.bytes > MAX_FRAME_BYTES)
    if (oversize.length) {
      return { source: 'fallback_state', description: null, reason: `帧过大：${oversize[0].bytes}B > ${MAX_FRAME_BYTES}B（先调小 width）` }
    }
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), VISION_TIMEOUT_MS)
      const r = await fetch(`${url.replace(/\/$/, '')}/frames`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Scene': 'mc',
        },
        body: JSON.stringify({
          frames: frames.map((f) => fs.readFileSync(f.file).toString('base64')),
          meta: {
            app_type: 'mc',
            window: `mc:look-${new Date().toISOString().slice(11, 19)}`,  // tablet-pet 的账本按 window 归组
            note: String(prompt || '').slice(0, 120),
            mime: 'jpeg',
          },
        }),
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      const j = await r.json().catch(() => null)
      if (!r.ok || !j) return { source: 'fallback_state', description: null, reason: `eye-server HTTP ${r.status}` }
      if (j.ok === false) return { source: 'fallback_state', description: null, reason: j.reason || 'eye-server 返回 ok:false' }
      const desc = j.desc || j.description || (j.data && j.data.desc) || null
      if (!desc) return { source: 'fallback_state', description: null, reason: 'eye-server 响应里没有 desc 字段' }
      return { source: 'vision', description: String(desc), reason: null }
    } catch (e) {
      return { source: 'fallback_state', description: null, reason: `视觉调用失败: ${e.message}` }
    }
  }

  /** 看不见时至少给她结构化事实，并且标明"这不是看见的" */
  function fallbackText(reason) {
    const s = snapshot()
    if (!s.connected) return `[非视觉] bot 未连接：${reason}`
    const around = []
    return `[非视觉·桥状态] 位置 ${s.pos.x},${s.pos.y},${s.pos.z}，手持 ${s.heldItem || '空'}，` +
      `血量 ${s.health}/20 饱食 ${s.food}/20，第 ${s.day} 天 ${s.time ? s.time.timeOfDay : '?'} 刻。` +
      `${reason ? '（' + reason + '）' : ''}`
  }

  async function handle(body = {}) {
    const b = getBot()
    const now = Date.now()

    // 限频：先算账再干活（贵操作，不能靠调用方自律）
    if (inflight) {
      const e = new Error('rate_limited: 上一次 /look 还没结束（同一取景器不能并发截图）')
      e.status = 429
      throw e
    }
    if (now - lastAt < MIN_INTERVAL_MS) {
      const e = new Error(`rate_limited: 两次 /look 至少间隔 ${MIN_INTERVAL_MS}ms`)
      e.status = 429
      e.retryAfterMs = MIN_INTERVAL_MS - (now - lastAt)
      throw e
    }
    if (usage.day !== today()) { usage = { day: today(), count: 0 }; saveUsage(usage) }
    if (usage.count >= DAILY_LIMIT) {
      const e = new Error(`daily_limit: 今日 /look 已用满 ${DAILY_LIMIT} 次`)
      e.status = 429
      throw e
    }
    lastAt = now
    usage.count++
    saveUsage(usage)
    inflight = true

    try {
      const framesWanted = Math.max(1, Math.min(Number(body.frames) || 1, MAX_FRAMES))
      const width = Math.max(320, Math.min(Number(body.width) || MAX_WIDTH, MAX_WIDTH))
      const mode = String(body.mode || 'first').toLowerCase() === 'third' ? 'third' : 'first'
      const orbit = mode === 'third' ? (body.orbit || null) : null
      const t0 = Date.now()

      // 可选转向：她贴墙站/背对时，先转头看目标（只转头，不移动，不破坏"第一人称"语义）
      if (mode === 'first' && body.lookAt && ['x', 'y', 'z'].every((k) => typeof body.lookAt[k] === 'number')) {
        try {
          const { Vec3 } = require('vec3')
          await b.lookAt(new Vec3(body.lookAt.x + 0.5, body.lookAt.y + 0.5, body.lookAt.z + 0.5), true)
          await new Promise((r) => setTimeout(r, 400))
        } catch (e) { log('[look] lookAt 失败: ' + e.message) }
      }

      // 第一人称退半步：怼着墙拍是废片，人会自己后退一点再看（主人 2026-11-08）
      let backOff = null
      if (mode === 'first' && body.backOff !== false) {
        try {
          backOff = await stepBackForView(b)
          if (backOff.attempted) {
            log(`[look] 第一人称贴脸（${backOff.triggerDist} 格有 ${backOff.blocker}），后退 ${backOff.moved} 格再拍`)
            for (const n of backOff.notes) log('[look] ' + n)
          }
        } catch (e) { log('[look] 后退取景失败（按原机位拍）: ' + e.message); backOff = null }
      }

      const frames = []
      let camera = null
      try {
        for (let i = 0; i < framesWanted; i++) {
          const f = await grab(mode, width, orbit, b.entity ? b.entity.yaw : 0)
          frames.push(f)
          if (i === 0 && f.camera) camera = f.camera
          if (i < framesWanted - 1) await new Promise((r) => setTimeout(r, 600))
        }
      } finally {
        // 退了就要走回来；走不回去也要如实交代，不能把人悄悄丢在半路
        if (backOff && backOff.moved > 0 && body.restore !== false) {
          try {
            const r = await undoNudge(b, backOff.moved)
            backOff.restored = r.restored
            backOff.restoredMoved = r.moved
            if (!r.restored) { backOff.notes.push('回位中止：' + r.why); log('[look] 回位中止：' + r.why) }
            else log('[look] 已走回拍照前的位置')
          } catch (e) { backOff.notes.push('回位失败: ' + e.message) }
        }
      }

      const v = await understand(frames, body.prompt)
      return {
        frames: frames.map((f) => f.file),
        savedTo: SHOTS_DIR,
        bytes: frames.reduce((s, f) => s + f.bytes, 0),
        width,
        mode,
        camera,                    // {liftedDeg, buried}：机位被抬高过就意味着构图不是你要的那个俯角
        backOff,                   // {attempted, moved, restored, clear, triggerDist, blocker}：第一人称退了几步
        lookAt: body.lookAt || null,
        orbit,
        description: v.source === 'vision' ? v.description : fallbackText(v.reason),
        source: v.source,          // vision | fallback_state | capture_only —— 必须看她拿到的是哪一种
        visionReason: v.reason,
        tookMs: Date.now() - t0,
        rate: { used: usage.count, limit: DAILY_LIMIT, minIntervalMs: MIN_INTERVAL_MS, day: usage.day },
      }
    } finally {
      inflight = false
    }
  }

  function usageInfo() {
    if (usage.day !== today()) return { used: 0, limit: DAILY_LIMIT, minIntervalMs: MIN_INTERVAL_MS, day: today(), cooldownMs: Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastAt)) }
    return { used: usage.count, limit: DAILY_LIMIT, minIntervalMs: MIN_INTERVAL_MS, day: usage.day, cooldownMs: Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastAt)) }
  }

  async function close() {
    try { if (browser) await browser.close() } catch (_) {}
    browser = null; page = null
  }

  return { handle, usageInfo, close }
}

module.exports = { createLooker, SHOTS_DIR, VIEWER_URL, MAX_FRAMES, MAX_WIDTH, DAILY_LIMIT, MIN_INTERVAL_MS }
