// run_cases.js — wait_probe fixture 跑测器（Node 侧，契约 wait/1）
// 与 bot/contract/wait_probe.py（Python 参考实现）跑同一份 fixtures/wait_probe_cases.json；
// 两边都绿才算契约成立。fixture 语义见 CONTRACT.md §8/§11。
//
// 用法:
//   node run_cases.js <cases.json>                 # 跑全量
//   node run_cases.js <cases.json> --mutation-check # 阳性对照：7 个变异体各自必须打红
//   node run_cases.js <cases.json> --dump gp_ge     # 打印单条用例完整响应
//   node run_cases.js <cases.json> --list           # 列 id/期望/path/快照数/意图
const fs = require('fs')
const wc = require('./wait-core')

// 7 个变异体（与 Python MUTANTS 对齐）：每个都必须至少打红一条用例
const MUTANTS = [
  { name: 'no_coercion', desc: '隐式类型转换（String 两边再比）', expect: ['ty_str_vs_num', 'ty_num_vs_null', 'ty_bool_vs_num'] },
  { name: 'ratio_ge', desc: '降级门 > 写成 >=', expect: ['dg_ratio_half'] },
  { name: 'allowlist_wide', desc: 'WAITABLE 放宽成"任何 / 开头"', expect: ['sc_inv', 'sc_toggle'] },
  { name: 'no_schema', desc: '去掉 /inv/count 静态 schema 预检', expect: ['iv_count_typo'] },
  { name: 'zero_as_missing', desc: '把 0 当成字段缺失', expect: ['iv_count_zero'] },
  { name: 'dollar_anchor', desc: '结尾锚点用 $ 而不是绝对结尾', expect: ['gn_trailing_nl'] },
  { name: 'unicode_digit', desc: '\\d 植回去（全角数字放行）', expect: ['gn_fullwidth_digit'] },
  { name: 'no_map_default', desc: '去掉 /inv/count 末段缺省 0（v1.1 MAP_DEFAULT）', expect: ['iv_count_absent_zero', 'iv_count_absent_nonzero'] },
  { name: 'strip', desc: '顺手 trim/折叠空格', expect: ['gn_double_space', 'gn_trailing_nl'] },
]

function loadDoc(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  // §11 规则 3/4：fixture_v 不认识整体拒；contract 不一致直接报错，不"尽力跑"
  if (doc.fixture_v !== 1) {
    console.error(`fixture_v 必须是 1，实际 ${JSON.stringify(doc.fixture_v)} —— 整体拒`)
    process.exit(2)
  }
  if (doc.contract && doc.contract !== wc.CONTRACT_NAME) {
    console.error(`contract 不匹配：夹具=${doc.contract} 实现=${wc.CONTRACT_NAME} —— 整体拒`)
    process.exit(2)
  }
  return doc
}

// 判定：expect 里每个键必须对上；响应里没有的键 = 红（拼错的键名会让用例永远绿）
function judge(c, got) {
  const bad = []
  for (const [k, want] of Object.entries(c.expect || {})) {
    if (!(k in got)) { bad.push(`${k}: expect 里有未知键（拼错就会静默通过）`); continue }
    if (got[k] !== want) bad.push(`${k}: 期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got[k])}`)
  }
  return bad
}

function check(doc, opts = {}) {
  const fails = []
  let shown = 0
  for (const c of doc.cases) {
    if (opts.dump && c.id !== opts.dump) continue
    const got = wc.runCase(c)
    if (opts.dump) { console.log(JSON.stringify(got, null, 2)); return 0 }
    const bad = judge(c, got)
    shown++
    if (bad.length) {
      fails.push(c.id)
      console.log(`RED   ${c.id.padEnd(28)} ${c.intent || ''}`)
      for (const b of bad) console.log(`        - ${b}`)
    } else if (opts.verbose) {
      console.log(`green ${c.id.padEnd(28)} ${(got.reason || '').padEnd(11)} ${c.intent || ''}`)
    }
  }
  if (opts.dump) return 0
  if (fails.length) {
    console.log(`\n${fails.length}/${shown} 红。契约未成立。`)
    return 1
  }
  console.log(`${shown}/${shown} 全绿（contract=${doc.contract || wc.CONTRACT_NAME}, fixture_v=${doc.fixture_v}）`)
  return 0
}

function mutationCheck(doc) {
  const redsFor = () => {
    const reds = []
    for (const c of doc.cases) {
      const bad = judge(c, wc.runCase(c))
      if (bad.length) reds.push(c.id)
    }
    return reds
  }
  const base = redsFor()
  if (base.length) {
    console.error(`基线都不过，先修基线再谈变异：${base.join(',')}`)
    return 1
  }
  console.log('基线全绿。开始逐个植入缺陷：\n')
  const notCaught = []
  for (const m of MUTANTS) {
    wc._setMutation(m.name)
    const reds = redsFor()
    wc._setMutation(null)
    if (!reds.length) {
      notCaught.push(m.name)
      console.log(`  ✗ ${m.name.padEnd(16)} ${m.desc.padEnd(30)} 一条都没红  <-- fixture 没牙`)
      continue
    }
    const missed = m.expect.filter((id) => !reds.includes(id))
    if (missed.length) {
      notCaught.push(m.name)
      console.log(`  ✓ ${m.name.padEnd(16)} ${m.desc.padEnd(30)} 打红 ${reds.length} 条: ${reds.slice(0, 4).join(',')}${reds.length > 4 ? '…' : ''}  （预期该红的 ${missed.join(',')} 没红）`)
    } else {
      console.log(`  ✓ ${m.name.padEnd(16)} ${m.desc.padEnd(30)} 打红 ${reds.length} 条: ${reds.slice(0, 4).join(',')}${reds.length > 4 ? '…' : ''}`)
    }
  }
  console.log()
  if (notCaught.length) {
    console.log(`${notCaught.length} 个变异体没被抓到 —— 这份 fixture 还不够当闸门。`)
    return 1
  }
  console.log(`全部 ${MUTANTS.length} 个变异体都被抓住：fixture 有鉴别力（不只是"能跑绿"）。`)
  return 0
}

;(async () => {
  const argv = process.argv.slice(2)
  const file = argv.find((a) => !a.startsWith('--'))
  if (!file) { console.error('用法: node run_cases.js <cases.json> [--mutation-check] [--dump ID] [--list]'); process.exit(2) }
  const doc = loadDoc(file)
  if (argv.includes('--list')) {
    console.log(`${'id'.padEnd(24)} ${'期望'.padEnd(6)} ${'path'.padEnd(12)} ${'快照'.padEnd(6)} 意图`)
    for (const c of doc.cases) {
      console.log(`${c.id.padEnd(24)} ${String((c.expect || {}).reason || '?').padEnd(6)} ${String(c.path || '?').padEnd(12)} ${String((c.snapshot || []).length).padEnd(6)} ${c.intent || ''}`)
    }
    console.log(`\n共 ${doc.cases.length} 条。`)
    return
  }
  const dumpIdx = argv.indexOf('--dump')
  if (dumpIdx !== -1) process.exit(check(doc, { dump: argv[dumpIdx + 1] }))
  if (argv.includes('--mutation-check')) {
    const rc = check(doc)
    if (rc) process.exit(rc)
    process.exit(mutationCheck(doc))
  }
  process.exit(check(doc, { verbose: argv.includes('--verbose') }))
})()
