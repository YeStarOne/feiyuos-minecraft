// test-wait.js — /wait 真实桥回归（需 bot 在跑；契约 wait/1 响应形状）
// 用法: node test-wait.js [base_url]   缺省 http://127.0.0.1:17700，云侧传 http://127.0.0.1:47880
const base = process.argv[2] || 'http://127.0.0.1:17700'
const cases = [
  { name: 'matched(health>5)', body: { path: '/state', condition: 'health > 5', timeout_s: 5 }, code: 200, expect: { reason: 'matched', matched: true } },
  { name: 'matched(invSlotsUsed>=0 零值合法)', body: { path: '/state', condition: 'invSlotsUsed >= 0', timeout_s: 5 }, code: 200, expect: { reason: 'matched', matched: true, samples_missing: 0 } },
  { name: 'matched(/inv/count 缺物品按0求值 v1.1)', body: { path: '/inv/count', condition: 'iron_ingot == 0', timeout_s: 5 }, code: 200, expect: { reason: 'matched', matched: true, samples_missing: 0 } },
  { name: 'timeout(health>999)', body: { path: '/state', condition: 'health > 999', timeout_s: 3 }, code: 200, expect: { reason: 'timeout', matched: false } },
  { name: '400 path_not_waitable(/inv)', body: { path: '/inv', condition: 'a > 1' }, code: 400, expect: { reason: 'bad_request', detail: 'path_not_waitable', samples_total: 0 } },
  { name: '400 unknown_field(笔误stoen)', body: { path: '/inv/count', condition: 'stoen >= 1' }, code: 400, expect: { reason: 'bad_request', detail: 'unknown_field' }, hasHint: true },
  { name: '400 request_shape(timeout_s=0)', body: { path: '/state', condition: 'health > 5', timeout_s: 0 }, code: 400, expect: { reason: 'bad_request', detail: 'request_shape' } },
  { name: '400 request_shape(condition非字符串)', body: { path: '/state', condition: 123 }, code: 400, expect: { reason: 'bad_request', detail: 'request_shape' } },
  { name: '400 expr_len(129字符)', body: { path: '/state', condition: 'health > 5 ' + 'x'.repeat(120) }, code: 400, expect: { reason: 'bad_request', detail: 'expr_len' } },
]
;(async () => {
  let pass = 0, fail = 0
  for (const c of cases) {
    try {
      const t0 = Date.now()
      const r = await fetch(base + '/wait', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.body) })
      const b = await r.json()
      const ms = Date.now() - t0
      const bads = []
      if (r.status !== c.code) bads.push(`code=${r.status} 期望${c.code}`)
      if (b.contract !== 'wait/1.1') bads.push(`contract=${b.contract}`)
      for (const [k, want] of Object.entries(c.expect)) if (b[k] !== want) bads.push(`${k}: 期望${JSON.stringify(want)} 实际${JSON.stringify(b[k])}`)
      if (c.hasHint && !(b.hint && Array.isArray(b.hint.nearest_names) && b.hint.nearest_names.length > 0 && b.hint.nearest_names.length <= 8)) bads.push('hint 必须带 nearest_names(1..8 个)')
      if (c.code === 200 && typeof b.elapsed_ms !== 'number') bads.push('缺 elapsed_ms')
      if (c.expect.reason === 'timeout' && ms < 2800) bads.push(`timeout 提前返回 ${ms}ms`)
      if (bads.length) { fail++; console.log(`FAIL ${c.name}  [${ms}ms]`); bads.forEach((x) => console.log('     ' + x)) }
      else { pass++; console.log(`PASS ${c.name}  [${ms}ms] reason=${b.reason} samples=${b.samples_total}`) }
    } catch (e) { fail++; console.log(`FAIL ${c.name} 异常: ${e.message}`) }
  }
  console.log(`\n${pass}/${cases.length} passed`)
  process.exit(fail ? 1 : 0)
})()
