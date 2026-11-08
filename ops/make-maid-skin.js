// make-maid-skin.js — 按 wine_fox_maid（女仆大肥鱼）重画 64×64 玩家皮肤（v2）
//
// 真源（逐区对照，不取色凭感觉）：
//   assets/authors_and_credits/models/entity/wine_fox_maid.json      bedrock 几何
//   assets/authors_and_credits/textures/entity/wine_fox_maid.png     128×128 图集
//
// v2 关键修正（v1 被视觉模型读成"南瓜头"，主人也不认）：
//   1. 脸不是人脸：头部正面 UV(32,21) 8×8 逐像素照抄 —— 橙色毛边 + 中央奶油口鼻
//      (#fce6d8) + 两侧白眼眶(#f4f3f8)黑瞳(#292621)褐下沿(#bf6739) + 下缘粉腮红(#f8bfb8)
//   2. 耳朵要"有体积"：模型里 ear 是两根 1×5×1 细柱、从头顶中部(±1.8)向外撇 ±30°，
//      高度 5 而头才 8 —— 所以画在两块竖起的大三角（顶面 + 前额上缘各留一段），有深色描边
//   3. 长发及背：模型 head 带一块 8×13×8 的下垂发块 → 头发盖到身体背面/两侧上半
//   4. 躯干上橙下黑：贴图 (26,31) 6×9 是"上面毛、下面裙"，配白围裙
//
// 用法: NODE_PATH=<bot>/node_modules node make-maid-skin.js [out.png]
const fs = require('fs')
const path = require('path')
const { createCanvas, loadImage } = require('canvas')

const OUT = process.argv[2] || path.join(__dirname, '..', 'skins', 'dafeiyu_maid.png')
const TEX = process.env.MAID_TEX || 'G:/minecraft-ai/neoforge-server/tlm_custom_pack/touhou_little_maid-1.0.0/assets/authors_and_credits/textures/entity/wine_fox_maid.png'

const C = {
  fur: '#e2a66e', furMid: '#de9b5f', furDark: '#c07f42', furLight: '#e7b887', furTip: '#fce6d8',
  muffler: '#fce6d8',
  dress: '#303030', dressDark: '#20202a',
  apron: '#f0f0f0', apronShade: '#dcdcdc',
  stocking: '#2b2b2b', stripe: '#f0f0f0', shoe: '#141414',
}

const cv = createCanvas(64, 64)
const ctx = cv.getContext('2d')
ctx.imageSmoothingEnabled = false
const px = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1) }
const rect = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h) }

// 原脸 8×8（UV 32,21），逐像素照抄
const FACE = [
  ['#de9b5f', '#e2a66e', '#e1a36a', '#e2aa73', '#df9d63', '#e1a36a', '#e2a972', '#e2a66e'],
  ['#e2a56d', '#e2ab75', '#e2a972', '#e2ab75', '#e1a56c', '#e2a871', '#e3ad76', '#e2a66e'],
  ['#e4af7a', '#e3ad76', '#e3ad78', '#e4b07c', '#e2aa73', '#e4b17e', '#e4b07c', '#e2ab75'],
  ['#e4af7b', '#e5b381', '#e4af7a', '#fce6d8', '#e4af7a', '#fce6d8', '#e6b685', '#e4af7a'],
  ['#e2ab75', '#e6b786', '#fce6d8', '#fce6d8', '#fce6d8', '#fce6d8', '#e7b887', '#e2a871'],
  ['#e2a66e', '#f4f3f8', '#292621', '#fce6d8', '#fce6d8', '#292621', '#f4f3f8', '#e1a46b'],
  ['#e0a268', '#f4f3f8', '#bf6739', '#fce6d8', '#fce6d8', '#bf6739', '#f4f3f8', '#de9b5f'],
  ['#e1a56c', '#f8bfb8', '#fce6d8', '#fce6d8', '#fce6d8', '#fce6d8', '#f8bfb8', '#de9a5e'],
]

// ================= 头 =================
// 布局：top(8,0,8x8) bottom(16,0) right(0,8) front/脸(8,8) left(16,8) back(24,8)
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px(8 + x, 8 + y, FACE[y][x])   // 脸：原样
rect(8, 0, 8, 8, C.fur)        // 顶面
rect(24, 8, 8, 8, C.fur)       // 后脑
rect(0, 8, 8, 8, C.fur)        // 右侧
rect(16, 8, 8, 8, C.fur)       // 左侧
rect(16, 0, 8, 8, C.furDark)   // 底面

// --- 耳朵（有体积感：顶面两块大三角 + 前额上缘各挑两格 + 后脑上缘各挑两格）---
// 顶面坐标系：x 0..7 = 左右，y 0..7 = 前(贴脸)到后
const ear = (x0, dir) => {
  for (let i = 0; i < 5; i++) {
    const w = 5 - i                       // 底宽 5 → 顶尖 1
    const left = x0 + Math.round((dir * i) / 2)   // 向外撇
    for (let w2 = 0; w2 < w; w2++) px(8 + left + w2, 0 + i, i >= 3 ? C.furTip : (i === 0 ? C.furDark : C.fur))
  }
  // 描边（让轮廓在远处也能读出来）
  px(8 + x0 - 1, 0, C.furDark); px(8 + x0 + 5, 0, C.furDark)
  // 耳根压到前额：脸面上缘两侧各两格深色（耳朵"长出来"的位置）
  const fx = x0 < 4 ? 8 + 1 : 8 + 5
  px(fx, 8, C.furDark); px(fx + 1, 8, C.furDark)
  // 后脑上缘呼应
  const bx = x0 < 4 ? 24 + 1 : 24 + 5
  px(bx, 8, C.furDark); px(bx + 1, 8, C.furDark)
}
ear(1, -1)   // 左耳（画面左）
ear(4, 1)    // 右耳
// 耳内浅色尖 + 两侧上缘各挑一格，让侧面也能看出耳朵
px(8 + 2, 1, C.furTip); px(8 + 5, 1, C.furTip)
px(0, 8, C.furDark); px(16, 8, C.furDark)

// ================= 身体（12 高）=================
// 布局：top(20,16,8x4) bottom(28,16) right(16,20,4x12) front(20,20,8x12) left(28,20) back(32,20)
rect(20, 16, 8, 4, C.fur)        // 肩（毛）
rect(16, 20, 4, 12, C.dress)
rect(28, 20, 4, 12, C.dress)
rect(20, 20, 8, 12, C.dress)
rect(32, 20, 8, 12, C.dress)

// 正面：上 3 行毛（胸口/围脖），下接黑裙 + 白围裙
rect(20, 20, 8, 3, C.fur)
rect(21, 20, 6, 1, C.muffler)      // 围脖（奶油色）
rect(22, 23, 4, 7, C.apron)        // 白围裙
px(22, 23, C.apronShade); px(25, 23, C.apronShade)
rect(20, 27, 8, 1, C.dressDark)    // 腰带

// 背面：上半是垂下来的长发，下半是裙 + 尾巴
rect(32, 20, 8, 5, C.fur)          // 长发及背
for (const [x, y] of [[33, 21], [35, 23], [38, 22], [34, 24], [37, 25]]) px(x, y, C.furLight)
rect(32, 25, 8, 7, C.dress)
// 尾巴：从腰到裙摆的 S 形，加粗、带浅色尖
rect(35, 24, 3, 2, C.fur)
rect(34, 26, 4, 3, C.fur)
rect(35, 29, 3, 2, C.furDark)
px(35, 31, C.furTip); px(36, 31, C.furTip); px(37, 30, C.furTip)
// 两侧也带一点尾巴压角，转身时不断片
rect(16, 28, 4, 2, C.fur); rect(28, 28, 4, 2, C.fur)

// ================= 手臂（1.8：左/右独立区域）=================
// 右臂 y=16..32：top(44,16,4x4) bottom(48,16) right(40,20) front(44,20) left(48,20) back(52,20)
// 左臂 y=48..64：top(36,48) bottom(40,48) right(32,52) front(36,52) left(40,52) back(44,52)
const arm = (tx, ty, bx, rx, ry, fx, lx, kx) => {
  rect(tx, ty, 4, 4, C.fur)
  rect(bx, ty, 4, 4, C.furDark)
  for (const u of [rx, fx, lx, kx]) {
    rect(u, ry, 4, 9, C.fur)              // 毛臂（无袖）
    rect(u, ry + 9, 4, 3, C.apron)        // 白袖口
    px(u, ry + 9, C.apronShade)
  }
}
arm(44, 16, 48, 40, 20, 44, 48, 52)
arm(36, 48, 40, 32, 52, 36, 40, 44)

// ================= 腿（黑丝 + 竖白条）=================
// 右腿 y=16..32：top(4,16) bottom(8,16) right(0,20) front(4,20) left(8,20) back(12,20)
// 左腿 y=48..64：top(20,48) bottom(24,48) right(16,52) front(20,52) left(24,52) back(28,52)
const leg = (tx, ty, bx, rx, ry, fx, lx, kx) => {
  rect(tx, ty, 4, 4, C.stocking)
  rect(bx, ty, 4, 4, C.stocking)
  for (const u of [rx, fx, lx, kx]) {
    rect(u, ry, 4, 12, C.stocking)
    rect(u + 1, ry, 1, 10, C.stripe)
    rect(u, ry + 10, 4, 2, C.shoe)
  }
}
leg(4, 16, 8, 0, 20, 4, 8, 12)
leg(20, 48, 24, 16, 52, 20, 24, 28)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, cv.toBuffer('image/png'))
console.log('已生成', OUT)
