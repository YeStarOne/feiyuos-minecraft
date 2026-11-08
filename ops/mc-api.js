// mc CLI - 鱼鱼 MC 桥命令行（中文必须走 node fetch，curl 会 GBK 乱码）
// 用法: node mc-api.js <state|health|pos|inv|time|chat TEXT|dig X Y Z|path X Y Z>
const BASE = 'http://127.0.0.1:17700'

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd) {
    console.log('用法: node mc-api.js <state|health|pos|inv|time|chat TEXT|dig X Y Z|path X Y Z>')
    process.exit(1)
  }
  const get = async (p) => (await fetch(BASE + p)).json()
  const post = async (p, body) =>
    (await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })).json()

  let r
  switch (cmd) {
    case 'state': r = await get('/state'); break
    case 'health': r = await get('/health'); break
    case 'pos': r = await get('/pos'); break
    case 'inv': r = await get('/inv'); break
    case 'time': r = await get('/time'); break
    case 'chat': r = await post('/chat', { text: args.join(' ') }); break
    case 'dig': r = await post('/dig', { x: +args[0], y: +args[1], z: +args[2] }); break
    case 'path': r = await post('/path', { x: +args[0], y: +args[1], z: +args[2] }); break
    default:
      console.log('未知命令:', cmd); process.exit(1)
  }
  console.log(JSON.stringify(r, null, 1))
}
main().catch((e) => { console.error('mc CLI 失败:', e.message); process.exit(1) })
