# numen 数字生命车道（鱼鱼玩我的世界 · 第二车道）

> 归属：mc-waixing 会话（numen 模块主持）｜建立：2026-11-22
> 状态：**真机全链路验收通过**——服务器+客户端+模型档案+人设+皮肤+YSM 换装+目标循环+战斗反射+重启恢复，全部实跑实证。
> 与第一车道（`bot/` mineflayer 桥）并存：那条道鱼鱼是**云脑 + bot 身体**；这条道鱼鱼是 **mod 同伴实体 + 客户端进程内大脑**，自己生存。

## 定位

一句话：用 numen mod（0.1.4.1）把鱼鱼变成世界里的同伴实体——她有自己的大脑（客户端进程内 LLM 循环，接自家 agent2api）、自己的人设、自己的皮肤/YSM 模型、自己的长期目标，在生存模式下自己砍树、种地、盖屋、挖铁，会打怪会汇报。

## 架构（实机 0.1.4.1，与 numen master 源码有差异，以本模块为准）

```
主人客户端 (PCL 1.21.1-NeoForge_Cam, javaw)
  ├─ numen-neoforge-1.21.1-0.1.4.1.jar  ← ⭐大脑在客户端进程：LLM 循环/Lua 工具面/聊天面板全在客户端跑
  │     config/numen/  ← 大脑的家（全部本地）：
  │       providers.json           模型档案（api_key 明文，不进本仓）
  │       persona/<名字>.md        人设（平铺单文件）
  │       skin.json + skins/<id>.png  皮肤（MineSkin 预签名 entry + 原图）
  │       companions/<uuid>/       goal.json / binding.json / chat.jsonl / inbox.jsonl
  └─ ysm.jar + ysm/<模型>.ysm      ← 身体模型（OwnerSync 授权后同伴可换装）
        │
NeoForge 服务器 (G:\minecraft-ai\neoforge-server, 25566, rcon 25576)
  ├─ numen-neoforge-1.21.1-0.1.4.1.jar  ← 同伴持久化 world/data/numen_companions.dat + 同伴实体
  └─ ysm.jar
        │
LLM：自家 agent2api http://127.0.0.1:3065/v1（OpenAI 兼容，provider=vllm，ctx 200000）
```

**为什么大脑在客户端**：聊天面板是客户端屏幕，`/goal` 是客户端命令，chat.jsonl 写在客户端盘上。服务器只认同伴实体和持久化 NBT。所以「重启客户端=重启她的大脑，服务器存档=保住她的身体」。

## 两条车道对比

| | 车道一 `bot/`（mineflayer） | 车道二 `numen/`（本模块） |
|---|---|---|
| 身体 | mineflayer bot（离线玩家） | numen 同伴实体（服务端持久化） |
| 大脑 | 云上 superagent | 客户端进程内（mod 自带 LLM 循环） |
| 模型 | superagent 配置 | providers.json（OpenAI 兼容任意 base_url） |
| 工具面 | HTTP 桥 19 端点 + MCP 6 工具 | mod 内置 Lua API（numen.scan/build/move/inv/work/use/fi...） |
| 皮肤 | make-maid-skin.js | MineSkin 预签名 entry + YSM 模型授权 |
| 端口 | 25570 / 17700 / 47880 | 25566 / 25576（MineClawd AI 建筑服） |
| 适合 | 云端 7×24 常驻 | 单机真机陪伴 + 自己生存 |

## 接入卡

| 项 | 值 |
|---|---|
| 客户端版本目录 | `G:\PCL 正式版 2.13.1.1\.minecraft\versions\1.21.1-NeoForge_Cam\` |
| 客户端必需 mod | numen-neoforge-1.21.1-0.1.4.1.jar + ysm.jar（etlan-helper 可选：水印/小地图同步） |
| 服务器 | `G:\minecraft-ai\neoforge-server`（NeoForge 1.21.1，25566，rcon 25576） |
| 服务器必需 mod | numen-neoforge-1.21.1-0.1.4.1.jar + ysm.jar（**双侧同名 jar，版本一致**） |
| 同伴 | Feiyu uuid=`fd0bf637-9cf5-4cea-9229-74be14f04938`（persona=鱼鱼，skin=skin_fatfish01，provider=deepdeep） |
| LLM | 自家 agent2api（OpenAI 兼容）；key 只存客户端 providers.json，**不进本仓** |
| YSM | `ysm/DS鲸鱼娘flash.ysm`（All Right Reserved，**不进仓**）；同伴换装=`ysm.model.switch("文件名.ysm")`，可换范围=主人授权模型（OwnerSync） |

## 部署五步（细节见 [docs/部署手册.md](docs/部署手册.md)）

1. 服务器 + 客户端各装 numen / ysm 双 jar（两侧同名同版本）
2. 客户端 `config/numen/providers.json` 建模型档案（模板 [configs/providers.sample.json](configs/providers.sample.json)）
3. 人设落 `config/numen/persona/<名字>.md`（模板 [configs/persona-鱼鱼.md](configs/persona-鱼鱼.md)）
4. 皮肤构造 skin.json entry + 原图（模板 [configs/skin.sample.json](configs/skin.sample.json)，MineSkin 预签名免重签）→ **重启客户端**
5. G 面板添加伙伴 → 编辑卡绑人设/皮肤/模型 → 聊天面板输入框 `/goal <目标>`（模板 [configs/goal-samples.md](configs/goal-samples.md)）

## 红线

1. **api_key 不进仓**：providers.json 只存客户端；仓里只有 sample（占位 key）
2. **YSM 模型文件不进仓**（All Right Reserved）：换装走 OwnerSync 授权 + `ysm.model.switch`，不拷文件
3. **`/goal` 只在 G 面板聊天输入框有效**：原版聊天框(T)输=发服务器报「未知或不完整的命令」
4. numen 表单点击类操作让主人真鼠标来；自动化只做 typeText 型（聊天框/搜索框），GLFW 合成点击无效（见 [docs/实机格式与坑.md](docs/实机格式与坑.md)）
5. 键盘被吞先看 IME：AX 树出现 CiceroUIWndFrame=输入法活动，按 Shift 切英文再按键
6. 原版聊天/RCON 说的话**她听不到**（她的耳朵只接聊天面板）——给她递话只能走 G 面板

## 验收证据（2026-11-22 真机）

- 模型档案「检测」绿「连接成功，模型响应正常」；goal checklist 在聊天面板顶部常驻渲染
- chat.jsonl 292 行 LLM 真跑：`numen.scan.map` 找 7×7 平地、材料预算 41<196 自己换策略、寻路 16 步到点、`numen.build.place` 报 no_material 后自己砍木补料
- 生存推进：石质工具✅ 盖屋（床/箱/门）✅ 挖铁全套铁甲✅；战斗反射层实证（僵尸→mob_defense 自动反击+进度 Monster Hunter）
- YSM 换装实证：服务器日志 `[YSM] Set 'DS鲸鱼娘flash.ysm' models for player 'Feiyu'`
- 重启恢复：杀 javaw → scripts/launch-client.py 拉起 → 自动连服 → 同伴自动重进，goal/binding/库全从盘恢复，零手工

## 本模块目录

| 文件 | 内容 |
|---|---|
| [docs/部署手册.md](docs/部署手册.md) | 从零到她开口的全流程（含保存没反应、/goal 发错框等现场坑） |
| [docs/实机格式与坑.md](docs/实机格式与坑.md) | 0.1.4.1 存储格式/热生效规则/UI 自动化/启动命令陷阱/重启恢复链/判活口径/蓝图幂等 |
| configs/persona-鱼鱼.md | 人设全文（八节，傲娇鲸鱼内核） |
| configs/providers.sample.json | 模型档案模板（key 占位） |
| configs/skin.sample.json | 皮肤 entry 模板（MineSkin 预签名字段占位） |
| configs/goal-samples.md | 目标文案模板（自己生存/跟建/巡逻） |
| configs/client.local.sample.json | 本机路径模板（真实文件 gitignore） |
| scripts/launch-client.py | 无窗拉起客户端（PCL 掩码 uuid 陷阱已修） |
| scripts/mc-rcon.py | RCON 小工具（丢怪/送物资/查世界状态） |
