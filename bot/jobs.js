// jobs.js — MC 身体的「自主长任务」层 + 地标记忆
//
// 设计来源：酒狐女仆（Touhou Little Maid fork）的 MaidJobManager / MaidAutopilotData。
// 抄的是**规则**，不是**速率**：那边跑在服务端 tick 里（destroyBlock 瞬发、每 tick 推一步），
// 这边是生存模式、真实挖掘耗时，所以每一步都 await 到真正完成。
//
// 两个子系统：
//   1) 地标记忆 —— 落盘（必须活过重启，否则记忆无意义）
//        remember / recall / verify；上限 24（TLM 注释说"按维度分开"但实现是全局 24，按实现抄）
//        同维度 8 格内视为同一地点 → 覆盖改名并清零 mismatches（TLM MaidAutopilotData:300）
//        连续 2 次核对失败即遗忘
//   2) 长任务 —— 只存内存，重启清空（照 TLM setJob 注释：避免半途状态错乱）
//        dig_shaft 安全阶梯下矿：2 格宽、每步挖 4 格（主/副台阶 + 各自头顶净空）、
//        开挖前 6 处流体检查（目标/头顶/脚下 ×2 列）+ 目标 6 邻居流体、
//        台阶下方是空气即中止（洞窟/悬崖，阶梯规则失效）、每 6 格放火把、
//        90 秒无推进即中止、15 分钟总上限、完工扫井壁矿脉并报告
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const STATE_DIR = path.join(__dirname, 'state')
const LANDMARKS_FILE = path.join(STATE_DIR, 'landmarks.json')

const MAX_LANDMARKS = 24
const LANDMARK_REFRESH_DIST_SQR = 64 // 同维度 8 格内 → 同一地标
const FORGET_MISMATCHES = 2
const NAME_MAX = 40

const SHAFT_MAX_DEPTH = 24
const DIG_REACH = 4.5 // 眼到方块中心（比 /dig 的 6 格保守，生存实测更稳）
const TORCH_EVERY = 6
const JOB_TIMEOUT_MS = 15 * 60 * 1000
const STALL_MS = 90 * 1000
const MOVE_TIMEOUT_MS = 30 * 1000
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } // [dx, dz]
const AIRS = new Set(['air', 'cave_air', 'void_air'])
const FLUIDS = new Set(['water', 'lava'])

// 蓝图（TLM startBuildHut 的三个档；house_2f 那条 9x9 两层+阳台管线未移植，显式拒绝而不是建歪）
const BLUEPRINTS = {
  hut_small: { size: 3, wallHeight: 2 },
  hut: { size: 5, wallHeight: 3 },
}
// 材料优先级（TLM pickMaterial）
const MATERIALS = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'cobblestone', 'stone', 'stone_bricks', 'smooth_stone', 'granite', 'diorite', 'andesite']
// 断点续建时视作"这格已经正确"的方块（TLM isBlueprintSolid）
const BLUEPRINT_SOLID = new Set(['oak_planks', 'spruce_planks', 'birch_planks', 'cobblestone', 'stone', 'glass'])

const isAir = (b) => !b || AIRS.has(b.name)
const isFluid = (b) => !!b && FLUIDS.has(b.name)

/** 自然地形方块（清场可挖）；人造方块一律不碰 —— TLM isNaturalBlock 同名移植 */
function isNaturalBlock(name) {
  return name.endsWith('_log') || name.endsWith('_leaves') || name.endsWith('_bush')
    || ['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud',
      'sand', 'red_sand', 'gravel', 'clay', 'snow', 'snow_block', 'powder_snow',
      'short_grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy',
      'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'calcite',
      'cobweb', 'moss_block', 'moss_carpet', 'vine', 'dead_bush', 'sugar_cane', 'bamboo',
      'water', 'lava'].includes(name)
    || name.endsWith('_flower') || name.endsWith('_tulip')
}

/** 墙位置：周长一圈 × 高度（门洞由调用方跳过） */
function wallPositions(origin, size, height) {
  const out = []
  const half = Math.floor(size / 2)
  for (let h = 0; h < height; h++)
    for (let x = -half; x <= half; x++)
      for (let z = -half; z <= half; z++)
        if (Math.abs(x) === half || Math.abs(z) === half) out.push(origin.offset(x, h, z))
  return out
}

/** 屋顶：一个满 size×size 平面 */
function roofPositions(origin, size, height) {
  const out = []
  const half = Math.floor(size / 2)
  for (let x = -half; x <= half; x++)
    for (let z = -half; z <= half; z++) out.push(origin.offset(x, height, z))
  return out
}

// ---------------- 地标 ----------------

function loadDoc() {
  try {
    const d = JSON.parse(fs.readFileSync(LANDMARKS_FILE, 'utf8'))
    if (d && Array.isArray(d.landmarks)) return d
  } catch (e) { /* 文件不存在/损坏 → 空库，不阻断启动 */ }
  return { version: 1, landmarks: [] }
}

function saveDoc(doc) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${LANDMARKS_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2))
  fs.renameSync(tmp, LANDMARKS_FILE) // 原子替换（记忆与地标别读到半个文件）
}

function createLandmarks({ getBot }) {
  const doc = loadDoc()
  let dirty = false

  function recall(bot) {
    const p = bot.entity.position
    return doc.landmarks
      .map((lm) => ({
        name: lm.name, x: lm.x, y: lm.y, z: lm.z, dim: lm.dim,
        distance: +Math.hypot(lm.x - p.x, lm.y - p.y, lm.z - p.z).toFixed(1),
        mismatches: lm.mismatches || 0,
      }))
      .sort((a, b) => a.distance - b.distance)
  }

  function remember(bot, rawName, atPos) {
    const name = String(rawName || '').trim()
    if (!name) throw new Error('name required for remember')
    if (name.length > NAME_MAX) throw new Error(`name too long (>${NAME_MAX})`)
    const pos = atPos ? atPos.floored() : bot.entity.position.floored()
    const dim = bot.game.dimension
    // 8 格内同维度 = 同一地点 → 覆盖（避免同一个矿脉被记成十几条）
    const near = doc.landmarks.find((lm) => lm.dim === dim && (
      (lm.x - pos.x) ** 2 + (lm.y - pos.y) ** 2 + (lm.z - pos.z) ** 2 <= LANDMARK_REFRESH_DIST_SQR
    ))
    if (near) {
      near.name = name; near.x = pos.x; near.y = pos.y; near.z = pos.z
      near.mismatches = 0; near.updatedAt = new Date().toISOString()
      dirty = true
      saveDoc(doc)
      return { action: 'remember', refreshed: true, name, pos: { x: pos.x, y: pos.y, z: pos.z }, total: doc.landmarks.length, max: MAX_LANDMARKS }
    }
    if (doc.landmarks.length >= MAX_LANDMARKS) doc.landmarks.shift() // 满了挤掉最老的（TLM 同款）
    doc.landmarks.push({ name, x: pos.x, y: pos.y, z: pos.z, dim, mismatches: 0, createdAt: new Date().toISOString() })
    dirty = true
    saveDoc(doc)
    return { action: 'remember', refreshed: false, name, pos: { x: pos.x, y: pos.y, z: pos.z }, total: doc.landmarks.length, max: MAX_LANDMARKS }
  }

  function verify(rawName, found) {
    const name = String(rawName || '').trim()
    if (!name) throw new Error('name required for verify')
    const lm = doc.landmarks.find((x) => x.name === name)
    if (!lm) throw new Error(`no landmark named '${name}' (用 GET /landmark 看全部)`)
    if (found) {
      lm.mismatches = 0
      saveDoc(doc)
      return { action: 'verify', name, found: true, mismatches: 0, forgotten: false }
    }
    lm.mismatches = (lm.mismatches || 0) + 1
    if (lm.mismatches >= FORGET_MISMATCHES) {
      doc.landmarks = doc.landmarks.filter((x) => x !== lm)
      saveDoc(doc)
      return { action: 'verify', name, found: false, mismatches: lm.mismatches, forgotten: true, total: doc.landmarks.length }
    }
    saveDoc(doc)
    return { action: 'verify', name, found: false, mismatches: lm.mismatches, forgotten: false, note: '再错一次就会被遗忘' }
  }

  /** HTTP 入口：GET 只读 recall，POST 按 action 分派 */
  async function handle({ action, name, found } = {}) {
    const bot = getBot()
    const act = String(action || 'recall').toLowerCase()
    if (act === 'recall') {
      const list = recall(bot)
      return { action: 'recall', total: list.length, max: MAX_LANDMARKS, landmarks: list }
    }
    if (act === 'remember') return remember(bot, name)
    if (act === 'verify') return verify(name, found !== false)
    throw new Error(`unknown action: ${act}（remember / recall / verify）`)
  }

  return { handle, recall, remember, verify, dirty: () => dirty, find: (name) => doc.landmarks.find((x) => x.name === String(name || '').trim()) }
}

// ---------------- 方块工具 ----------------

function facingDir(bot) {
  // Minecraft yaw: 0=+Z(南), π/2=-X(西), π=-Z(北), -π/2=+X(东)
  const yaw = ((bot.entity.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  const oct = Math.round(yaw / (Math.PI / 2)) % 4
  return ['south', 'west', 'north', 'east'][oct]
}

function eyeDist(bot, pos) {
  const e = bot.entity.position.offset(0, bot.entity.height ? bot.entity.height * 0.9 : 1.6, 0)
  return e.distanceTo(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5))
}

/** 开挖前安全检查（TLM checkDigSafety）：返回 null=安全，否则人类可读原因 */
function checkDigSafety(bot, target, head, floor) {
  if (isFluid(bot.blockAt(target))) return `目标位置是${bot.blockAt(target).name === 'lava' ? '岩浆' : '水'}`
  if (isFluid(bot.blockAt(head))) return `头顶是${bot.blockAt(head).name === 'lava' ? '岩浆' : '水'}`
  if (isFluid(bot.blockAt(floor))) return `脚下是${bot.blockAt(floor).name === 'lava' ? '岩浆' : '水'}`
  if (isAir(bot.blockAt(floor))) return '台阶下方是空腔（洞窟/悬崖），阶梯挖掘不再安全'
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = target.offset(dx, dy, dz)
    if (isFluid(bot.blockAt(n))) {
      return `目标方块旁紧邻${bot.blockAt(n).name === 'lava' ? '岩浆' : '水'}`
    }
  }
  return null
}

function createJobs({ getBot, runAction, log = () => {}, landmarks = null }) {
  let job = null // 运行中的作业（内存 only）
  let last = null // 上一次作业的收尾报告（GET /job 还能读到）

  function status() {
    const base = {
      running: !!job,
      type: job ? job.type : null,
      phase: job ? job.phase : null,
      step: job ? job.step : null,
      maxDepth: job ? job.maxDepth : null,
      dir: job ? job.dir : null,
      torches: job ? job.torches : null,
      blueprint: job ? job.blueprint : null,
      placed: job ? job.placed : null,
      total: job ? job.total : null,
      elapsedMs: job ? Date.now() - job.startedAt : null,
      lastProgressAgoMs: job ? Date.now() - job.lastProgressAt : null,
      last,
    }
    return base
  }

  function report(ok, text, extra = {}) {
    last = {
      ok, type: job ? job.type : (extra.type || null), report: text,
      at: new Date().toISOString(),
      durationMs: job ? Date.now() - job.startedAt : null,
      ...extra,
    }
    log(`[job] ${ok ? 'OK' : 'FAIL'} ${text}`)
    return last
  }

  function finish(ok, text, extra) {
    const r = report(ok, text, extra)
    job = null
    return r
  }

  // ---- 单步动作（全部走 runAction，与她的动作串行，不会互抢）----

  async function walkTo(p, tolH = 1.5, tolY = 0.6) {
    const b = getBot()
    const arrived = () => {
      const e = b.entity.position
      return Math.hypot(p.x + 0.5 - e.x, p.z + 0.5 - e.z) <= tolH && Math.abs(e.y - p.y) <= tolY
    }
    if (arrived()) return
    const goto = () => runAction(() => Promise.race([
      b.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('walk timeout')), MOVE_TIMEOUT_MS)),
    ]).catch((e) => {
      // 「Took to long to decide path」≠ 没走到（手册 §1）：以到达判定为准
      try { b.pathfinder.stop() } catch (_) {}
      if (!arrived()) throw e
    }))
    try { await goto() } catch (_) {}
    if (arrived()) return
    await runAction(() => clearPathTo(b, p)) // 自救一：挖穿中间的挡路方块
    try { await goto() } catch (_) {}
    if (arrived()) return
    await runAction(() => widenHeadroom(b)) // 自救二：加高头位
    try { await goto() } catch (_) {}
    if (!arrived()) throw new Error(`走不到台阶位置 (${p.x},${p.y},${p.z})`)
  }

  /** 挖穿她与目标之间的挡路方块（脚位+头位，只碰可挖方块，绝不挖流体/基岩） */
  async function clearPathTo(b, target) {
    const from = b.entity.position.floored()
    const dx = Math.sign(target.x - from.x), dz = Math.sign(target.z - from.z)
    const dy = Math.sign(target.y - from.y)
    let cur = from.offset(0, 0, 0), dug = 0
    for (let i = 0; i < 6; i++) {
      cur = (dx === 0 && dz === 0) ? cur.offset(0, dy, 0) : cur.offset(dx, 0, dz)
      for (const p of [cur, cur.offset(0, 1, 0)]) {
        const blk = b.blockAt(p)
        if (isAir(blk) || isFluid(blk) || blk.diggable === false) continue
        if (eyeDist(b, p) > DIG_REACH) break
        try { await b.dig(blk) ; dug++ } catch (_) {}
      }
      if (cur.equals(target)) break
    }
    if (dug) log(`[job] 自救清路：挖掉 ${dug} 个挡路方块`)
  }

  /** 加高当前位置头位（只碰脚上方两层，绝不动脚下地板）*/
  async function widenHeadroom(b) {
    const c = b.entity.position.floored()
    let dug = 0
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = 1; dy <= 2; dy++) {
          const p = c.offset(dx, dy, dz)
          const blk = b.blockAt(p)
          if (isAir(blk) || isFluid(blk) || blk.diggable === false) continue
          if (eyeDist(b, p) > DIG_REACH) continue
          try { await b.dig(blk); dug++ } catch (_) {}
        }
    if (dug) log(`[job] 自救加高头位：${dug} 个方块`)
  }

  /** 自己头/身体被埋就挖出来（否则窒息死，TLM 01:46 事故） */
  async function ensureHeadroomForSelf(b) {
    const pos = b.entity.position.floored()
    for (let dy = 1; dy <= 2; dy++) {
      const p = pos.offset(0, dy, 0)
      const blk = b.blockAt(p)
      if (isAir(blk) || isFluid(blk) || blk.diggable === false) continue
      if (eyeDist(b, p) > DIG_REACH) continue
      try { await b.dig(blk); log(`[job] 自救：挖开埋住自己的方块 ${p.x},${p.y},${p.z}`) } catch (_) {}
    }
  }

  /** 目标为固体且挖得动就挖，返回是否挖到 */
  async function mineIfSolid(b, p) {
    const blk = b.blockAt(p)
    if (isAir(blk) || isFluid(blk) || blk.diggable === false) return false
    if (eyeDist(b, p) > DIG_REACH) return false
    try { await b.dig(blk); return true } catch (_) { return false }
  }

  // ---- dig_shaft 主循环 ----

  async function digShaftLoop() {
    const [dx, dz] = DIRS[job.dir]
    const side = [dz, -dx] // 顺时针垂直（2 格宽的副列）
    const start = job.start

    while (true) {
      if (job.cancel) return finish(false, `job dig_shaft aborted at depth ${job.step}: ${job.cancel}。已停止。`, { step: job.step })
      if (Date.now() - job.startedAt > JOB_TIMEOUT_MS) {
        return finish(false, `job dig_shaft aborted at depth ${job.step}: 超过 15 分钟总时限，已停止。入口 ${fmt(start)}。`, { step: job.step })
      }
      if (Date.now() - job.lastProgressAt > STALL_MS) {
        return finish(false, `job dig_shaft aborted at depth ${job.step}: 卡住了（90 秒没有任何推进），入口在 ${fmt(start)}。`, { step: job.step })
      }
      if (job.step >= job.maxDepth) {
        const ores = scanShaftOres()
        if (landmarks) { try { landmarks.remember(getBot(), '矿井入口', job.start) } catch (_) {} }
        return finish(true, `job dig_shaft completed: 深度 ${job.step} 的阶梯矿井已挖好，入口在 ${fmt(start)}。${ores}`, { step: job.step, torches: job.torches })
      }

      const step = job.step
      const nextStep = step + 1
      const b = getBot()
      const standAt = start.offset(dx * step, -step, dz * step)

      job.phase = 'walking'
      await walkTo(standAt)
      await runAction(() => ensureHeadroomForSelf(b))

      const targetA = start.offset(dx * nextStep, -nextStep, dz * nextStep)
      const targetB = targetA.offset(side[0], 0, side[1])
      const headA = targetA.offset(0, 1, 0)
      const headB = targetB.offset(0, 1, 0)
      const floorA = targetA.offset(0, -1, 0)
      const floorB = targetB.offset(0, -1, 0)

      job.phase = 'checking'
      const danger = checkDigSafety(b, targetA, headA, floorA) || checkDigSafety(b, targetB, headB, floorB)
      if (danger) {
        // 遇险：中止并走回地面（照 TLM：停下 + 回入口，如实报告）
        job.phase = 'returning'
        await walkTo(start, 2.0, 1.5).catch(() => {})
        return finish(false, `job dig_shaft aborted at depth ${step}: ${danger}。已停止下挖并返回入口 ${fmt(start)}。`, { step })
      }

      job.phase = 'digging'
      let dug = 0
      for (const p of [targetA, headA, targetB, headB]) {
        if (job.cancel) break
        if (await runAction(() => mineIfSolid(b, p))) dug++
      }

      // 每 6 格放一支火把（放在头顶空位，下方必须有支撑）
      if (nextStep % TORCH_EVERY === 0) {
        await runAction(async () => {
          const torch = b.inventory.items().find((i) => i.name === 'torch')
          if (!torch) return
          for (const p of [headA, headB]) {
            if (!isAir(b.blockAt(p)) || isAir(b.blockAt(p.offset(0, -1, 0)))) continue
            try {
              await b.equip(torch, 'hand')
              await b.placeBlock(b.blockAt(p.offset(0, -1, 0)), new Vec3(0, 1, 0))
              job.torches++
            } catch (_) {}
            break
          }
        })
      }

      if (!dug) {
        job.retries++
        if (job.retries > 3) {
          return finish(false, `job dig_shaft aborted at depth ${step}: 无法挖穿前方方块（保护区域或未知方块）。`, { step })
        }
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      job.retries = 0
      job.step = nextStep
      job.lastProgressAt = Date.now()
      log(`[job] dig_shaft step ${nextStep} done (dug=${dug}) @ ${fmt(targetA)}`)
    }
  }

  function scanShaftOres() {
    const b = getBot()
    const [dx, dz] = DIRS[job.dir]
    const found = new Set()
    for (let s = 1; s <= job.step; s++) {
      const p = job.start.offset(dx * s, -s, dz * s)
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let dy = -1; dy <= 1; dy++) {
          const n = p.offset(ox, dy, oz)
          const blk = b.blockAt(n)
          if (blk && (blk.name.endsWith('_ore') || blk.name === 'ancient_debris')) found.add(`${blk.name}@${fmt(n)}`)
        }
      }
    }
    if (!found.size) return '井壁未发现裸露矿脉（可换方向再挖一条，或去洞窟找）。'
    return '井壁矿脉: ' + Array.from(found).slice(0, 12).join(', ') + '。可用 /find 精确定位后逐个挖。'
  }

  async function startDigShaft({ max_depth, dir } = {}) {
    if (job) throw new Error(`another job is already running (${job.type}, phase ${job.phase})`)
    const b = getBot()
    const start = b.entity.position.floored()
    const d = String(dir || facingDir(b)).toLowerCase()
    if (!DIRS[d]) throw new Error('dir 必须是 north/south/east/west')
    const maxDepth = Math.max(1, Math.min(Number(max_depth) || SHAFT_MAX_DEPTH, SHAFT_MAX_DEPTH))
    if (isAir(b.blockAt(start.offset(0, -1, 0)))) throw new Error('not standing on solid ground（先站到地面上）')

    job = {
      type: 'dig_shaft', phase: 'starting', start, dir: d, step: 0, maxDepth,
      torches: 0, retries: 0, startedAt: Date.now(), lastProgressAt: Date.now(), cancel: null,
    }
    const started = { ...job }
    delete started.cancel
    // 后台跑，HTTP 立刻返回（长活不能挂住一次请求 15 分钟）
    digShaftLoop().catch((e) => {
      const done = finish(false, `job dig_shaft crashed at depth ${job ? job.step : '?'}: ${e.message}`)
      log(`[job] crash ${e.stack || e.message}`)
      return done
    })
    return {
      started: true, type: 'dig_shaft', dir: d, maxDepth,
      start: { x: start.x, y: start.y, z: start.z }, at: started.startedAt,
      hint: '现在可以结束本轮；用 GET /job 查进度和收尾报告（running=false 时看 last）',
    }
  }

  // ---- build_hut 蓝图建房（TLM startBuildHut/tickBuildHut 规则移植）----

  /** 走到够得着的位置（够不着就寻路靠近；失败不抛，由调用方的距离校验决定） */
  async function approach(p) {
    const b = getBot()
    if (eyeDist(b, p) <= DIG_REACH) return
    try {
      await runAction(() => Promise.race([
        b.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('walk timeout')), MOVE_TIMEOUT_MS)),
      ]).catch(() => { try { b.pathfinder.stop() } catch (_) {} }))
    } catch (_) {}
  }

  /** 放一块：找相邻实心方块当参照，放完读回校验（TLM 那边 setBlockAndUpdate 必成，这边会静默失败） */
  async function placeAt(b, pos, item) {
    if (!b.heldItem || b.heldItem.name !== item.name) await b.equip(item, 'hand')
    const refs = [
      [new Vec3(0, -1, 0), new Vec3(0, 1, 0)],
      [new Vec3(0, 0, 1), new Vec3(0, 0, -1)],
      [new Vec3(0, 0, -1), new Vec3(0, 0, 1)],
      [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)],
      [new Vec3(-1, 0, 0), new Vec3(1, 0, 0)],
    ]
    for (const [off, face] of refs) {
      const ref = b.blockAt(pos.plus(off))
      if (!ref || isAir(ref) || ref.boundingBox !== 'block') continue
      try { await b.placeBlock(ref, face) } catch (_) { continue }
      const after = b.blockAt(pos)
      if (after && after.name === item.name) return true
    }
    return false
  }

  async function buildHutLoop() {
    const b = getBot()
    const bp = BLUEPRINTS[job.blueprint]
    const size = bp.size, wallHeight = bp.wallHeight
    const origin = job.origin
    const half = Math.floor(size / 2)
    const order = [...wallPositions(origin, size, wallHeight), ...roofPositions(origin, size, wallHeight)]
    // 门 = 北墙中列下两层。⚠️ TLM 的 doorPos 是 origin.relative(NORTH, size/2).offset(0,0,-size/2)
    //    —— 连减两次 size/2，落到墙外 2 格，实际门洞从未生效（注释_write的是"北墙中间"）。
    //    这里按注释意图修正，并在文档里标注与上游的差异。
    const door = new Set([`${origin.x},${origin.y},${origin.z - half}`, `${origin.x},${origin.y + 1},${origin.z - half}`])
    const isDoor = (p) => door.has(fmt(p))
    job.total = order.filter((p) => !isDoor(p)).length
    job.done = 0

    // 0) 选址预检（动工前，一块都不挖）：
    //    TLM 只清墙圈和屋顶，屋子内部不碰 —— 选到树中间就会"屋里长一根树干"（2026-11-08 实测踩到）。
    //    这里先只读扫描内部体积，有实心障碍直接拒绝并点名，让她换地而不是建出个修补现场。
    //    ⚠️ y 从 1 起：y=0 是地面层，屋内地面本来就是实心的，不能算障碍。
    const solid = (blk) => blk && !isAir(blk) && blk.boundingBox === 'block'
    const obstructions = []
    for (let x = -half + 1; x <= half - 1; x++)
      for (let z = -half + 1; z <= half - 1; z++)
        for (let y = 1; y < wallHeight; y++) {
          const p = origin.offset(x, y, z)
          const blk = b.blockAt(p)
          if (solid(blk)) obstructions.push(`${blk.name}@${fmt(p)}`)
        }
    if (obstructions.length) {
      return finish(false, `job build_hut aborted: 选址内部有障碍（${obstructions.slice(0, 4).join(', ')}${obstructions.length > 4 ? ' 等' : ''}），` +
        `换一块空地再建（或先用 /dig 清掉内部）。一块都没挖。`)
    }

    // 1) 清场：自然方块挖掉；人造方块一律中止（大创造低破坏）
    job.phase = 'clearing'
    for (const p of order) {
      if (job.cancel) return finish(false, `job build_hut aborted: ${job.cancel}。已建部分保留。`)
      if (isDoor(p)) continue
      const blk = b.blockAt(p)
      if (isAir(blk)) continue
      if (isFluid(blk)) return finish(false, `job build_hut aborted: 选址上有${blk.name}（${fmt(p)}），换一块空地再建。`)
      if (!isNaturalBlock(blk.name)) {
        return finish(false, `job build_hut aborted: 选址被已有方块占用（${blk.name}@${fmt(p)}），换一块空地再建。`)
      }
      await approach(p)
      if (eyeDist(b, p) > DIG_REACH) return finish(false, `job build_hut aborted: 够不着清场目标 ${fmt(p)}（卡住了）。`)
      await runAction(async () => { try { await b.dig(b.blockAt(p)) } catch (_) {} })
      job.lastProgressAt = Date.now()
    }

    // 2) 逐块放置：墙自下而上 → 屋顶（已是正确方块就跳过 = 断点续建）
    job.phase = 'building'
    for (const p of order) {
      if (job.cancel) return finish(false, `job build_hut aborted at ${job.done}/${job.total}: ${job.cancel}。已建部分保留。`, { placed: job.done })
      if (isDoor(p)) continue
      const cur = b.blockAt(p)
      if (cur && (cur.name === job.material || BLUEPRINT_SOLID.has(cur.name))) { job.done++; continue }
      if (!isAir(cur)) {
        if (!isNaturalBlock(cur.name)) { job.done++; continue } // 人造方块：不拆，跳过这格
        await approach(p)
        if (eyeDist(b, p) > DIG_REACH) { job.done++; continue }
        await runAction(async () => { try { await b.dig(b.blockAt(p)) } catch (_) {} })
      }
      const item = b.inventory.items().find((it) => it.name === job.material)
      if (!item) {
        if (landmarks) { try { landmarks.remember(b, '未完工小屋') } catch (_) {} }
        return finish(false, `job build_hut aborted: 材料用尽（还差 ${job.total - job.done} 块）。已建部分保留，补齐后再次调用会续建。`, { placed: job.done })
      }
      await approach(p)
      if (eyeDist(b, p) > DIG_REACH) { job.done++; continue }
      const ok = await runAction(() => placeAt(b, p, item))
      job.done++
      if (ok) { job.placed++; job.lastProgressAt = Date.now() } else log(`[job] build_hut 放不下 ${fmt(p)}，跳过`)
    }

    // 3) 收尾：室内点火把（有就点）
    await runAction(async () => {
      const torch = b.inventory.items().find((i) => i.name === 'torch')
      if (!torch) return
      const p = origin.offset(0, 1, 0)
      if (!isAir(b.blockAt(p)) || isAir(b.blockAt(p.offset(0, -1, 0)))) return
      try {
        await b.equip(torch, 'hand')
        await b.placeBlock(b.blockAt(p.offset(0, -1, 0)), new Vec3(0, 1, 0))
        job.torches = 1
      } catch (_) {}
    })
    if (landmarks) { try { landmarks.remember(b, `小屋(${job.blueprint})`, origin) } catch (_) {} }
    return finish(true, `job build_hut completed: ${job.blueprint} 建好了（${size}x${size}，墙高 ${wallHeight}），位置 ${fmt(origin)}，材料 ${job.material}，实放 ${job.placed}/${job.total} 块，已记入地标记忆。`, { placed: job.placed })
  }

  async function startBuildHut({ blueprint, dir } = {}) {
    if (job) throw new Error(`another job is already running (${job.type}, phase ${job.phase})`)
    const name = String(blueprint || 'hut_small').toLowerCase().trim()
    if (name === 'house_2f' || name === 'house') {
      throw new Error('house_2f（9x9 两层+阳台，约 350 块）还没移植，先支持 hut_small / hut')
    }
    const spec = BLUEPRINTS[name] || BLUEPRINTS.hut_small
    const bpName = BLUEPRINTS[name] ? name : 'hut_small'
    const b = getBot()

    // 材料核算：木板优先 → 圆石/石类（开工前报确切缺口，不建到一半才说）
    const material = MATERIALS.find((m) => b.inventory.items().some((i) => i.name === m))
    if (!material) throw new Error('missing_materials: 背包里没有建筑方块（木板/圆石/石砖）。先砍树或挖石。')
    const have = b.inventory.items().filter((i) => i.name === material).reduce((s, i) => s + i.count, 0)
    const need = (spec.size * 4 - 4) * spec.wallHeight - 2 + spec.size * spec.size
    if (have < need) {
      throw new Error(`missing_materials: ${bpName} 需要 ${need} 块 ${material}，当前只有 ${have} 块，还差 ${need - have} 块`)
    }

    const d = String(dir || facingDir(b)).toLowerCase()
    if (!DIRS[d]) throw new Error('dir 必须是 north/south/east/west')
    const [dx, dz] = DIRS[d]
    const center = b.entity.position.floored()
    // TLM：站在场地中心会把自己包进墙里 → 以面向方向后退 2 格为参考点
    const origin = center.offset(-dx * 2, 0, -dz * 2)

    job = {
      type: 'build_hut', phase: 'starting', blueprint: bpName, origin, dir: d, material,
      size: spec.size, wallHeight: spec.wallHeight, placed: 0, done: 0, total: null, torches: 0,
      startedAt: Date.now(), lastProgressAt: Date.now(), cancel: null,
    }
    buildHutLoop().catch((e) => {
      finish(false, `job build_hut crashed: ${e.message}`)
      log(`[job] crash ${e.stack || e.message}`)
    })
    return {
      started: true, type: 'build_hut', blueprint: bpName, dir: d, material,
      need, have, origin: { x: origin.x, y: origin.y, z: origin.z },
      hint: '现在可以结束本轮；用 GET /job 查进度和收尾报告（running=false 时看 last）',
    }
  }

  async function handle(body = {}) {
    const type = body.type || (body.action === 'abort' ? 'abort' : null)
    if (type === 'abort') {
      if (!job) return { aborted: false, note: '当前没有运行中的作业' }
      job.cancel = String(body.reason || 'manual abort')
      return { aborted: true, type: job.type, step: job.step }
    }
    if (type === 'dig_shaft') return startDigShaft(body)
    if (type === 'build_hut') return startBuildHut(body)
    throw new Error('job type 必须是 dig_shaft / build_hut（abort 用 {"action":"abort"}）')
  }

  /** 掉线/死亡时由 bot.js 调用：作业不能跨身体存活 */
  function onBotGone(reason) {
    if (!job) return
    job.cancel = `bot 掉线/死亡：${reason}`
    log(`[job] ${job.type} 收到 bot-gone 信号：${reason}`)
  }

  return { handle, status, onBotGone, get running() { return !!job } }
}

const fmt = (p) => `${p.x},${p.y},${p.z}`

module.exports = { createLandmarks, createJobs, MAX_LANDMARKS, SHAFT_MAX_DEPTH, facingDir }
