// Daily world backup: RCON save-off -> copy world -> save-on, keep 14 days
const { Rcon } = require('rcon-client')
const fs = require('fs')
const path = require('path')
const SERVER = 'G:/feiyu-mc/server'
const BK = 'G:/feiyu-mc/backups'

async function main() {
  fs.mkdirSync(BK, { recursive: true })
  const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25575, password: process.env.MC_RCON_PASSWORD || '' })
  await rcon.send('save-off')
  try { await rcon.send('save-all flush') } catch (e) { console.log('save-all flush 慢/超时，继续拷贝:', e.message) }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const dest = path.join(BK, `world-${stamp}`)
  await fs.promises.cp(path.join(SERVER, 'world'), dest, {
    recursive: true,
    filter: (src) => !src.includes('session.lock'), // MC 文件锁，save-off 也不释放，排除
  })
  await rcon.send('save-on')
  await rcon.end()
  const sz = execDu(dest)
  console.log(`备份完成: ${dest} (${sz})`)
  // prune > 14 days
  const cutoff = Date.now() - 14 * 86400 * 1000
  for (const f of fs.readdirSync(BK)) {
    if (!f.startsWith('world-')) continue
    const p = path.join(BK, f)
    if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { recursive: true, force: true }); console.log('清理过期备份:', f) }
  }
}
function execDu(d) {
  try {
    const { execSync } = require('child_process')
    return execSync(`du -sh "${d}"`, { shell: 'bash' }).toString().split('\t')[0].trim()
  } catch { return '?' }
}
main().catch((e) => { console.error('备份失败:', e.message); process.exit(1) })
