# Fabric 迁移预案（一页纸）

> 触发条件：主人想在这个世界装模组（YUNG 系结构、When Dungeons Arise、Structory 等）。
> 当前：Paper 1.21.1（纯原版协议）｜迁移目标：Fabric 1.21.1（服务端-only mod 不改协议，mineflayer 照连）

## 为什么是 Fabric 不是 NeoForge

| 路线 | mineflayer 能否进 | 结论 |
|---|---|---|
| Paper 1.21.1（现行） | ✅ 原生 | 现在用它 |
| **Fabric 1.21.1** | ✅ 服务端-only mod 不改协议 | **装模组的正确目标** |
| NeoForge 服务端 + Gate 代理 | 实验（NeoForge 1.21.x 未明确） | 不押注 |
| NeoForge + 服内 Java 假人 | 要重写整个 bot 层 | 将来再说（旧 MineClawd 是先例） |

## 变什么

1. 服务端：Paper jar → `fabric-loader 1.21.1` + `fabric-server-launch.jar`，`server-ip=127.0.0.1` / `online-mode=false` 等属性不变（server.properties 摘要保留）
2. 装服务端 mod：`neoforge 服务端 mod → 对应 Fabric 版`；清单候选：
   - When Dungeons Arise（Fabric 1.21 ✓ 服务端直装）
   - Structory（数据包式，服务端直装）
   - YUNG 系（要客户端也装 → 主人 PCL 加一个 Fabric profile）
3. 世界：vanilla world 存档 Fabric 直接吃（同版本），**迁移前照常备份**

## 不变什么

- bot（mineflayer 4.39）、桥层（17700）、RCON/备份/计划任务、隧道 47880 **全部保留**，一行不改
- `mc` CLI、superagent source（HTTP 契约）不感知服务端类型

## 迁移步骤（估 1 小时）

1. `ops\backup-world.js` 备份 + 停服（stop.flag）
2. 服务端目录旁建 `server-fabric\`，拷 `world/` + `server.properties` 关键项
3. 下 fabric-server-launch（MDL 指定 1.21.1），装 Fabric API + 目标 mod 进 `mods\`
4. 首启验 `Done`，bot 探针跑三判据，主人 PCL Fabric profile 进服
5. 全绿后改计划任务指向 server-fabric；Paper 目录保留回滚（回滚=反向改指针，世界未变）
