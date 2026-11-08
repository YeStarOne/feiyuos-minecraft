// RCON one-shot command tool: node mc-cmd.js [command] [port]  (default: list, 25575)
const { Rcon } = require('rcon-client')
const cmd = process.argv[2] || 'list'
const port = Number(process.argv[3]) || 25575
Rcon.connect({ host: '127.0.0.1', port, password: process.env.MC_RCON_PASSWORD || '' })
  .then(async (rcon) => {
    console.log(await rcon.send(cmd))
    await rcon.end()
  })
  .catch((e) => { console.error('RCON 失败:', e.message); process.exit(1) })
