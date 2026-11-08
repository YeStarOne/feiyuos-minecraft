// BlueWhaleMaid - FeiyuOS Minecraft Lane body + bridge (D2/D3)
// bot: mineflayer (offline, 1.21.1, 127.0.0.1:25570) with reconnect self-healing
// bridge: HTTP API on 127.0.0.1:17700 (process-level, survives reconnects)
//   GET  /health /state /pos /inv /inv/count /time | /landmark（地标列表） | /job（作业进度+收尾报告）
//        | /look（今日视觉配额） | /block（单格反查）
//   POST /chat {text} | /dig {x,y,z} | /path | /craft {name,count} | /equip {name} | /place {x,y,z}
//        | /find {name,count} | /block {x,y,z} | /mcp | /wait | /landmark {action,name,found}
//        | /job {type:"dig_shaft"|"build_hut"} | /look {frames,width,prompt}
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const http = require('http')
const waitCore = require('./wait-core')
const { createLandmarks, createJobs } = require('./jobs')
const { mineflayer: viewerPlugin } = require('prismarine-viewer')
const { createLooker } = require('./look')

const PORT = 17700
const startedAt = Date.now()
// 自动发言总开关（OS 主持披露项：这两处不是鱼鱼本人想说的话，必须可关）。
// true=现状（单人私服无妨）；若将来进多人群/公开场合，置 false 关掉全部自主发言。
const AUTO_CHAT = true
let currentBot = null
let reconnectDelay = 5000
let lastSpawnAt = null

// ---- 动作串行队列（并发=1）----
let chain = Promise.resolve()
let chainBusy = 0
function runAction(fn) {
  chainBusy++
  const p = chain.then(fn, fn)
  chain = p.catch(() => {}).then(() => { chainBusy-- })
  return p
}

// ---- 视觉捕获：prismarine-viewer 渲染服务（/look 的取景器）----
// 两个实例：3010 第一人称（=她的眼睛）/ 3011 第三人称（浏览器端 OrbitControls 环绕，看建筑/验收用）
// 原理：服务端只有在 firstPerson 时才发 pitch；不发 pitch 时前端走 orbit 分支，相机放在 pos+(0,20,20)
const VIEWER_PORT = 3010
const VIEWER_PORT_3P = 3011
let viewerClosers = []   // 插件每次调用都会覆盖 bot.viewer，所以 close 句柄必须自己留
function attachViewer(bot) {
  if (viewerClosers.length) {
    const cs = viewerClosers
    viewerClosers = []
    for (const f of cs) { try { f() } catch (_) {} }
    setTimeout(() => attachViewer(bot), 1500)   // 端口释放需要一点时间，否则 EADDRINUSE 会掀掉进程
    return
  }
  const mounts = [[VIEWER_PORT, true], [VIEWER_PORT_3P, false]]
  for (const [port, firstPerson] of mounts) {
    try {
      viewerPlugin(bot, { port, firstPerson, viewDistance: 6 })
      if (bot.viewer && typeof bot.viewer.close === 'function') viewerClosers.push(bot.viewer.close)
      console.log(`[viewer] ${firstPerson ? '第一人称' : '第三人称'} http://127.0.0.1:${port}`)
    } catch (e) {
      console.log(`[viewer] 端口 ${port} 挂载失败:`, e.message)
    }
  }
}

// ---- bot 连接（自愈）----
function connect() {
  const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25570,
    username: 'BlueWhaleMaid', version: '1.21.1', auth: 'offline',
  })
  currentBot = bot
  bot.loadPlugin(pathfinder)

  bot.once('spawn', () => {
    reconnectDelay = 5000
    lastSpawnAt = new Date().toISOString()
    console.log(JSON.stringify({ event: 'spawn', at: lastSpawnAt, pos: snapshot().pos }))
    attachViewer(bot)
    if (AUTO_CHAT) bot.chat('主人好！BlueWhaleMaid 上线啦~')
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    console.log(`[chat] <${username}> ${message}`)
    if (AUTO_CHAT && /blue|鱼鱼|maid|鲸/i.test(message)) bot.chat(`${username}，我在！`)
  })

  bot.on('death', () => {
    console.log(`[${new Date().toISOString()}] bot 死亡，立即重生`)
    jobs.onBotGone('death')
    try { bot.respawn() } catch (e) { console.log('respawn err:', e.message) }
  })
  bot.on('end', (reason) => {
    console.log(`[${new Date().toISOString()}] bot 离线: ${reason}, ${reconnectDelay / 1000}s 后重连`)
    jobs.onBotGone(reason)
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 300000)
  })
  bot.on('error', (e) => console.log('bot 错误:', e.message))
  bot.on('kicked', (r) => console.log('bot 被踢:', r))
}

// ---- 状态快照 ----
function snapshot() {
  const b = currentBot
  if (!b || !b.entity) return { connected: false }
  const p = b.entity.position
  return {
    connected: true,
    username: b.username,
    pos: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
    health: b.health, food: b.food, saturation: b.foodSaturation,
    dimension: b.game.dimension, gamemode: b.game.gameMode,
    time: b.time ? { timeOfDay: b.time.timeOfDay, day: b.time.day } : null,
    day: b.time ? b.time.day : null, // 顶层别名（与星露谷挂载器同款），她写 day >= 1 两身体通用
    players: Object.keys(b.players),
    onGround: b.entity.onGround,
    heldItem: b.heldItem ? b.heldItem.name : null,
    inv: b.inventory ? b.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot })) : [],
    invCount: itemCountMap() || {}, // 聚合列（OS 主持定：v1 用聚合不用下标）
    invSlotsUsed: b.inventory ? b.inventory.items().length : 0,
    invSlotsTotal: 36, // 原版玩家主背包 36 格（9 快捷 + 27 背包）
  }
}

function itemCountMap() {
  const b = currentBot
  if (!b || !b.entity || !b.inventory) return null
  const out = {}
  for (const it of b.inventory.items()) out[it.name] = (out[it.name] || 0) + it.count
  return out
}

// ---- 动作实现 ----
function requireBot() {
  const b = currentBot
  if (!b || !b.entity) throw new Error('bot not connected')
  return b
}
async function doDig({ x, y, z }) {
  const b = requireBot()
  const v = new Vec3(x, y, z)
  if (b.entity.position.distanceTo(v) > 6) throw new Error('too far (>6 blocks)')
  const blk = b.blockAt(v)
  if (!blk || blk.name === 'air' || blk.name === 'cave_air') throw new Error('no block there')
  await b.lookAt(blk.position, true)
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout 60s')), 60000))
  await Promise.race([b.dig(blk), timer])
  return { dug: blk.name, at: { x, y, z } }
}
function findNearbyTable(b, radius = 4) {
  const p = b.entity.position.floored()
  for (let dx = -radius; dx <= radius; dx++)
    for (let dy = -2; dy <= 2; dy++)
      for (let dz = -radius; dz <= radius; dz++) {
        const blk = b.blockAt(p.offset(dx, dy, dz))
        if (blk && blk.name === 'crafting_table') return blk
      }
  return null
}
async function doFind({ name, count }) {
  const b = requireBot()
  const block = b.registry.blocksByName[name] || b.registry.itemsByName[name]
  if (!block) throw new Error('unknown block/item: ' + name)
  // mineflayer findBlocks 在本环境恒空（blockAt 正常）→ 自己网格扫（水平±12，垂直±3）
  const c = b.entity.position.floored()
  const hits = []
  for (let dx = -12; dx <= 12 && hits.length < Math.min(Number(count) || 8, 64); dx++)
    for (let dz = -12; dz <= 12 && hits.length < Math.min(Number(count) || 8, 64); dz++)
      for (let dy = -3; dy <= 3; dy++) {
        const blk = b.blockAt(c.offset(dx, dy, dz))
        if (blk && blk.name === name) { hits.push({ x: blk.position.x, y: blk.position.y, z: blk.position.z, name: blk.name }); break }
      }
  const found = hits
  return { query: name, hits: found }
}
async function doCraft({ name, count }) {
  const b = requireBot()
  const item = b.registry.itemsByName[name]
  if (!item) throw new Error('unknown item: ' + name)
  const n = Math.max(1, Math.min(Number(count) || 1, 64))
  const table = findNearbyTable(b)
  const recipes = b.recipesFor(item.id, null, 1, table)
  if (!recipes.length) throw new Error('no recipe for ' + name + (table ? '' : '（3x3 配方需要合成台在 4 格内）'))
  await b.craft(recipes[0], n, table)
  return { crafted: name, count: n, usedTable: !!table }
}
async function doEquip({ name }) {
  const b = requireBot()
  const item = b.inventory.items().find(i => i.name === name)
  if (!item) throw new Error('not in inventory: ' + name)
  await b.equip(item, 'hand')
  return { equipped: name }
}
async function doPlace({ x, y, z }) {
  const b = requireBot()
  const v = new Vec3(x, y, z)
  if (b.entity.position.distanceTo(v) > 5.5) throw new Error('too far (>5.5 blocks)')
  const target = b.blockAt(v)
  if (target && target.name !== 'air' && target.name !== 'cave_air') throw new Error('target not air: ' + target.name)
  const below = b.blockAt(v.offset(0, -1, 0))
  if (!below || below.name === 'air' || below.name === 'cave_air') throw new Error('no support below')
  await b.placeBlock(below, new Vec3(0, 1, 0))
  return { placed: true, at: { x, y, z } }
}
async function doPath({ x, y, z }) {
  const b = requireBot()
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('path timeout 15min')), 15 * 60000))
  await Promise.race([b.pathfinder.goto(new goals.GoalNear(x, y, z, 1)), timer])
  return { arrived: true, pos: snapshot().pos }
}

// ---- 自主长任务层 + 地标记忆（照酒狐女仆 MaidJobManager 的规则译，见 jobs.js）----
const landmarks = createLandmarks({ getBot: requireBot })
const jobs = createJobs({ getBot: requireBot, runAction, landmarks, log: (m) => console.log(m) })
const look = createLooker({ getBot: requireBot, snapshot, log: (m) => console.log(m), canMove: () => chainBusy === 0 && !jobs.running })

// ---- MCP 工具面（JSON-RPC over POST /mcp，隧道单口 17700 全包）----
const TOOLS = [
  { name: 'mc_state', description: '鱼鱼的完整状态: 坐标/血量/饥饿/背包/维度/时间/在线玩家', inputSchema: { type: 'object', properties: {} } },
  { name: 'mc_chat', description: '让鱼鱼在游戏聊天栏说一句话', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'mc_dig', description: '挖掉指定坐标的方块(距离≤6格)', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] } },
  { name: 'mc_path', description: '寻路走到指定坐标附近(≤15分钟)', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] } },
  { name: 'mc_inv', description: '当前背包物品列表', inputSchema: { type: 'object', properties: {} } },
  { name: 'mc_time', description: '游戏内时间/天数', inputSchema: { type: 'object', properties: {} } },
]
async function handleMcp(res, msg) {
  const id = msg && msg.id !== undefined ? msg.id : null
  const ok = (result) => reply(res, 200, { jsonrpc: '2.0', id, result })
  const err = (code, message) => reply(res, 200, { jsonrpc: '2.0', id, error: { code, message } })
  if (!msg || typeof msg.method !== 'string') return err(-32700, 'parse error')
  switch (msg.method) {
    case 'initialize': return ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'feiyu-mc', version: '0.1.0' } })
    case 'notifications/initialized': res.writeHead(202); return res.end()
    case 'ping': return ok({})
    case 'tools/list': return ok({ tools: TOOLS })
    case 'tools/call': {
      const { name, arguments: a } = msg.params || {}
      try {
        let data
        if (name === 'mc_state') data = snapshot()
        else if (name === 'mc_inv') data = snapshot().inv
        else if (name === 'mc_time') data = snapshot().time
        else if (name === 'mc_chat') { requireBot().chat(String(a.text)); data = { said: a.text } }
        else if (name === 'mc_dig') data = await runAction(() => doDig(a))
        else if (name === 'mc_path') data = await runAction(() => doPath(a))
        else throw new Error('unknown tool: ' + name)
        return ok({ content: [{ type: 'text', text: JSON.stringify(data) }] })
      } catch (e) {
        return ok({ content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true })
      }
    }
    default: return err(-32601, 'method not found')
  }
}

// ---- 真实探针（/wait 的 probe_fn 挂载参数；single-flight 1s 复用）----
// payload_of：本桥统一 {ok,data} 包装 → unwrap；契约默认恒等，属挂载参数不属契约
const PAYLOAD_OF = (body) => (body && body.data !== undefined ? body.data : body)
const probeCache = {}
function probeBody(probe) {
  const now = Date.now()
  if (probeCache[probe] && now - probeCache[probe].at <= 1000) return probeCache[probe].r
  let r
  if (probe === '/health') {
    r = { status: 200, body: { ok: true, botConnected: !!(currentBot && currentBot.entity), lastSpawnAt, uptimeSec: Math.round((now - startedAt) / 1000) } }
  } else {
    const s = snapshot()
    r = s.connected
      ? { status: 200, body: { ok: true, data: { '/state': s, '/pos': s.pos, '/inv/count': itemCountMap() || {}, '/time': s.time }[probe] } }
      : { status: 503, body: { ok: false, data: null } }
  }
  probeCache[probe] = { at: now, r }
  return r
}
// /inv/count 的静态 schema：minecraft-data 全量物品名（判笔误用，不靠当前快照内容）
const ITEM_NAMES = new Set(Object.values(require('minecraft-data')('1.21.1').items).map((i) => i.name))
const waitHttp = waitCore.makeHttpHandler({ probeFn: probeBody, payloadOf: PAYLOAD_OF, schema: { '/inv/count': ITEM_NAMES } })

// ---- HTTP 桥 ----
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { resolve(null) } })
  })
}
const reply = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    if (req.method === 'GET') {
      switch (url.pathname) {
        case '/health': return reply(res, 200, {
          ok: true, botConnected: !!(currentBot && currentBot.entity),
          lastSpawnAt, uptimeSec: Math.round((Date.now() - startedAt) / 1000), autoChat: AUTO_CHAT,
        })
        case '/state': { const s = snapshot(); return reply(res, s.connected ? 200 : 503, { ok: s.connected, data: s }) }
        case '/pos': { const s = snapshot(); return reply(res, s.connected ? 200 : 503, { ok: s.connected, data: s.connected ? s.pos : null }) }
        case '/inv': { const s = snapshot(); return reply(res, s.connected ? 200 : 503, { ok: s.connected, data: s.connected ? s.inv : null }) }
        case '/inv/count': { const m = itemCountMap(); return reply(res, m ? 200 : 503, { ok: !!m, data: m }) }
        case '/time': { const s = snapshot(); return reply(res, s.connected ? 200 : 503, { ok: s.connected, data: s.connected ? s.time : null }) }
        case '/landmark': {
          if (!(currentBot && currentBot.entity)) return reply(res, 503, { ok: false, data: null, error: 'bot not connected' })
          const r = await landmarks.handle({ action: 'recall' })
          return reply(res, 200, { ok: true, data: r })
        }
        case '/job': return reply(res, 200, { ok: true, data: jobs.status() })
        case '/look': return reply(res, 200, { ok: true, data: look.usageInfo(), viewerPort: 3010 })
      }
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (url.pathname === '/mcp') return handleMcp(res, body)
      if (url.pathname === '/wait') { await waitHttp(req, res, body); return }   // 必须 await：异常进 try/catch 成 500，否则 unhandledRejection 直接杀进程
      if (body === null) return reply(res, 400, { ok: false, error: 'bad json' })
      if (url.pathname === '/chat') {
        if (!body.text) return reply(res, 400, { ok: false, error: 'text required' })
        requireBot().chat(String(body.text))
        return reply(res, 200, { ok: true, said: String(body.text) })
      }
      if (url.pathname === '/dig') {
        if ([body.x, body.y, body.z].some(v => typeof v !== 'number')) return reply(res, 400, { ok: false, error: 'x,y,z numbers required' })
        const r = await runAction(() => doDig(body))
        return reply(res, 200, { ok: true, data: r })
      }
      if (url.pathname === '/path') {
        if ([body.x, body.y, body.z].some(v => typeof v !== 'number')) return reply(res, 400, { ok: false, error: 'x,y,z numbers required' })
        const r = await runAction(() => doPath(body))
        return reply(res, 200, { ok: true, data: r })
      }
      if (url.pathname === '/find') {
        if (!body.name) return reply(res, 400, { ok: false, error: 'name required' })
        const r = await runAction(() => doFind(body))
        return reply(res, 200, { ok: true, data: r })
      }
      if (url.pathname === '/block') {
        // 单格反查（/find 是"名字→位置"，这条是"位置→名字"）：验收建筑、判断脚下/头顶是什么
        if ([body.x, body.y, body.z].some(v => typeof v !== 'number')) return reply(res, 400, { ok: false, error: 'x,y,z numbers required' })
        const b = requireBot()
        const blk = b.blockAt(new Vec3(body.x, body.y, body.z))
        if (!blk) return reply(res, 500, { ok: false, error: 'block not loaded（该区块未加载或超出视距）' })
        return reply(res, 200, {
          ok: true, data: {
            name: blk.name, at: { x: blk.position.x, y: blk.position.y, z: blk.position.z },
            diggable: blk.diggable !== false, boundingBox: blk.boundingBox, hardness: blk.hardness,
          },
        })
      }
      if (url.pathname === '/craft') {
        if (!body.name) return reply(res, 400, { ok: false, error: 'name required' })
        const r = await runAction(() => doCraft(body))
        return reply(res, 200, { ok: true, data: r })
      }
      if (url.pathname === '/equip') {
        if (!body.name) return reply(res, 400, { ok: false, error: 'name required' })
        const r = await runAction(() => doEquip(body))
        return reply(res, 200, { ok: true, data: r })
      }
      if (url.pathname === '/place') {
        if ([body.x, body.y, body.z].some(v => typeof v !== 'number')) return reply(res, 400, { ok: false, error: 'x,y,z numbers required' })
        const r = await runAction(() => doPlace(body))
        return reply(res, 200, { ok: true, data: r })
      }
      if (url.pathname === '/landmark') {
        // go：直接走过去（她在长任务里最常用的组合是 recall → go，不必自己拼 /path 坐标）
        if (String(body.action || '').toLowerCase() === 'go') {
          const lm = landmarks.find(body.name)
          if (!lm) return reply(res, 500, { ok: false, error: `no landmark named '${body.name}'（先 GET /landmark 看全部）` })
          const r = await runAction(() => doPath({ x: lm.x, y: lm.y, z: lm.z }))
          return reply(res, 200, { ok: true, data: { ...r, landmark: lm.name, target: { x: lm.x, y: lm.y, z: lm.z } } })
        }
        const r = await landmarks.handle(body)   // 内部对未知 action 抛错 → 500
        return reply(res, 200, { ok: true, data: r })
      }
      if (url.pathname === '/job') {
        const r = await jobs.handle(body)        // 未知 type 抛错 → 500（不是 400：与 /dig 的 500 口径一致）
        return reply(res, 200, { ok: true, data: r })
      }
      if (url.pathname === '/look') {
        // 视觉是贵操作：不走 runAction（不堵动作队列），自带限流，正常 2~6 秒
        const r = await look.handle(body)
        return reply(res, 200, { ok: true, data: r })
      }
    }
    reply(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    const code = e.status || 500
    const extra = e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}
    reply(res, code, { ok: false, error: e.message, ...extra })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[bridge] listening http://127.0.0.1:${PORT}`))

connect()
