// look-capture-test.mjs — 验证「无头渲染出帧」这条关键路径是否成立
// 做法：起一个独立短命 bot（LookTest 离线号）→ 挂 prismarine-viewer（浏览器 WebGL 渲染）
//       → puppeteer-core 用系统 Chrome 无头截图 → 落盘 PNG/JPEG
// 用法: node look-capture-test.mjs [outDir]
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { mineflayer: viewer } = require('prismarine-viewer')
const puppeteer = require('puppeteer-core')

const OUT = process.argv[2] || path.join(__dirname, '..', 'shots')
const VIEWER_PORT = 3011
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25570, username: 'LookTest', version: '1.21.1', auth: 'offline',
  })
  bot.on('error', (e) => console.log('bot err:', e.message))
  await new Promise((res, rej) => {
    bot.once('spawn', res)
    setTimeout(() => rej(new Error('spawn timeout 30s')), 30000)
  })
  const p = bot.entity.position
  console.log('spawn at', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1))
  bot.chat('look-test online')

  viewer(bot, { port: VIEWER_PORT, firstPerson: true })
  await sleep(2500) // 等 viewer 的 socket 和 chunk 流建立

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--window-size=800,600'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 600 })
  const errs = []
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })

  await page.goto(`http://127.0.0.1:${VIEWER_PORT}`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(4000) // 等 three.js 把 chunk 画出来

  const canvasInfo = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return { canvas: false }
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    return { canvas: true, w: c.width, h: c.height, webgl: !!gl, renderer: gl ? gl.getParameter(gl.RENDERER) : null }
  })
  console.log('canvas:', JSON.stringify(canvasInfo))

  const png = path.join(OUT, 'look-test.png')
  await page.screenshot({ path: png, type: 'png' })
  const jpg = path.join(OUT, 'look-test.jpg')
  await page.screenshot({ path: jpg, type: 'jpeg', quality: 80 })
  const sz = (f) => (fs.existsSync(f) ? fs.statSync(f).size : -1)
  console.log('png bytes:', sz(png), ' jpg bytes:', sz(jpg))
  if (errs.length) console.log('page errors:', errs.slice(0, 5).join(' | '))

  await browser.close()
  bot.quit()
  // 判据：文件存在且有字节 + canvas 存在且 WebGL 可用（不是黑屏就代表渲染成立，黑屏要看图）
  const okAll = canvasInfo.canvas && canvasInfo.webgl && sz(jpg) > 5000
  console.log(okAll ? 'CAPTURE_OK' : 'CAPTURE_FAIL')
  process.exit(okAll ? 0 : 1)
})().catch((e) => { console.error('FATAL', e.message); process.exit(1) })
