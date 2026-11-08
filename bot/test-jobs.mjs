// test-jobs.mjs — /landmark + /job 真实桥回归（不 mock，打 127.0.0.1:17700）
// 用法: node test-jobs.mjs            # 地标全流程
//       node test-jobs.mjs --dig      # 再跑一遍 dig_shaft（浅深度 2 格，会真的挖）
const BASE = 'http://127.0.0.1:17700'
let pass = 0, fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}
async function get(p) { const r = await fetch(BASE + p); return { code: r.status, body: await r.json() } }
async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
  return { code: r.status, body: await r.json() }
}

async function landmarks() {
  console.log('\n[1] 地标记忆（remember / recall / verify）')
  const base = await get('/landmark')
  ok(base.code === 200 && base.body.data.max === 24, 'GET /landmark 基线', `total=${base.body.data.total}`)
  const t0 = base.body.data.total

  const r1 = await post('/landmark', { action: 'remember', name: '回归测试点A' })
  ok(r1.code === 200 && r1.body.data.action === 'remember', 'remember 新建', JSON.stringify(r1.body.data.pos))
  ok(r1.body.data.total === t0 + 1 || r1.body.data.refreshed, 'total 递增（或 8 格内刷新）', `total=${r1.body.data.total}`)

  const r2 = await post('/landmark', { action: 'remember', name: '回归测试点A改' })
  ok(r2.body.data.refreshed === true && r2.body.data.total === r1.body.data.total, '同位置 8 格内 → 刷新而非新增', `total=${r2.body.data.total}`)

  const list = await get('/landmark')
  const hit = list.body.data.landmarks.find((x) => x.name === '回归测试点A改')
  // 存的是 floor 后的方块坐标，距离按真实位置算 → 站在上面时距离 ≤ 1（不是 0）
  ok(!!hit && hit.distance <= 1, 'recall 里能看到且距离 ≤1（坐标是 floor 的方块格）', hit ? `dist=${hit.distance}` : 'missing')

  const v1 = await post('/landmark', { action: 'verify', name: '回归测试点A改', found: false })
  ok(v1.body.data.mismatches === 1 && v1.body.data.forgotten === false, 'verify found=false 第一次 → mismatches=1 不遗忘')
  const v2 = await post('/landmark', { action: 'verify', name: '回归测试点A改', found: false })
  ok(v2.body.data.forgotten === true, 'verify 连续第二次 false → 遗忘')

  const r3 = await post('/landmark', { action: 'remember', name: '回归测试点B' })
  const v3 = await post('/landmark', { action: 'verify', name: '回归测试点B', found: true })
  ok(v3.body.data.mismatches === 0 && v3.body.data.forgotten === false, 'verify found=true → 清零不遗忘')
  // 收尾：清掉 B，把库恢复原状
  await post('/landmark', { action: 'verify', name: '回归测试点B', found: false })
  await post('/landmark', { action: 'verify', name: '回归测试点B', found: false })

  const bad = await post('/landmark', { action: 'nonsense' })
  ok(bad.code === 500 && /unknown action/.test(bad.body.error), '未知 action → 500', bad.body.error)
  const noname = await post('/landmark', { action: 'remember' })
  ok(noname.code === 500 && /name required/.test(noname.body.error), 'remember 缺 name → 500', noname.body.error)
  const final = await get('/landmark')
  ok(final.body.data.total === t0, '收尾：地标库恢复原状', `total=${final.body.data.total}`)
}

async function jobs() {
  console.log('\n[2] dig_shaft 作业')
  const before = await get('/job')
  ok(before.code === 200 && before.body.data.running === false, 'GET /job 基线 running=false')

  const s = await post('/job', { type: 'dig_shaft', max_depth: 2 })
  ok(s.code === 200 && s.body.data.started === true, 'POST /job dig_shaft 启动', `dir=${s.body.data?.dir} max=${s.body.data?.maxDepth}`)
  ok(typeof s.body.data.dir === 'string' && /north|south|east|west/.test(s.body.data.dir), '朝向解析成四方向之一')

  // 立刻再启一个 → 必须被拒（single-flight）
  const dup = await post('/job', { type: 'dig_shaft', max_depth: 1 })
  ok(dup.code === 500 && /another job/.test(dup.body.error), '并发启动被拒（single-flight）', dup.body.error)

  // 轮询到结束（最多 180s）
  const t0 = Date.now()
  let st
  while (Date.now() - t0 < 180000) {
    st = await get('/job')
    if (!st.body.data.running) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  const last = st.body.data.last
  ok(!!last, '有收尾报告', last ? `${last.ok ? 'OK' : 'FAIL'} ${last.report}` : '')
  ok(last && (last.step === 2 || /aborted/.test(last.report)), '推进到目标深度或如实中止', `step=${last?.step}`)

  const bad = await post('/job', { type: 'nonsense' })
  ok(bad.code === 500, '未知 type → 500', bad.body.error)
}

const withDig = process.argv.includes('--dig')
await landmarks()
if (withDig) await jobs()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
