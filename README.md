# feiyu-minecraft · 肥鱼 OS 的 Minecraft 车道

> 鱼鱼（BlueWhaleMaid）在 Minecraft 里的"身体"：mineflayer bot + HTTP 桥 + MCP 工具面。
> 本仓是 [feiyu-os](https://github.com/YeStarOne/feiyu-os) 的一个**车道仓**——一个游戏一个仓，可单独安装。
> 状态（2026-11-08）：Fabric 1.21.1 生产服 + 桥 19 端点 + MCP 6 工具 + wait/1.1 + 地标/长任务 + 视觉桥，全部真机验收。

## 接入卡（平台仓的模块注册表引用本节）

| 项 | 值 |
| --- | --- |
| 桥地址 | PC 本机 `127.0.0.1:17700`；云侧走反向隧道 `127.0.0.1:47880` |
| 视觉 | `POST /look`（prismarine-viewer 出帧 → eye-server `/frames`，`meta.app_type:"mc"`） |
| wait 契约 | `wait/1.1`（`bot/contract/CONTRACT.md`，与星露谷同一段文字） |
| superagent source | `code/superagent-sources/minecraft.ts`（平台仓），`actor=mc-bridge` |
| MCP | `POST /mcp`：mc_state / mc_chat / mc_dig / mc_path / mc_inv / mc_time |

## 端点一览（19 个，全部形状见 [docs/桥端点手册.md](docs/桥端点手册.md)）

- 只读：`/health`（平铺）/ `/state`（data 包裹）/ `/pos` `/inv` `/inv/count` `/time`
- 动作：`/chat` `/dig` `/path` `/craft` `/equip` `/place` `/find`（动作串行队列）
- 等待与任务：`/wait`（条件长轮询）/ `/landmark`（记忆/回家）/ `/job`（start/status/abort）
- 视觉：`/look`（第一人称帧 → 场景描述；`mode` 扩展中）
- MCP：`POST /mcp`（JSON-RPC，先 initialize）

## 安装（三步）

1. **服务器**：Fabric 1.21.1（见 [docs/Fabric迁移预案.md](docs/Fabric迁移预案.md)；`ops/use-fabric.flag` 控制开关，删 flag 重启=回滚 Paper）。关键 server.properties：`online-mode=false` + `enforce-secure-profile=false` + 端口绑定本机。
2. **桥**：`bot/` 下 `npm install`（需要 node 22 + 原生 canvas 依赖用于视觉出帧）→ `node bot.js`（计划任务脚本见 [ops/setup-tasks.ps1](ops/setup-tasks.ps1)）。
3. **接入**：平台仓 `superagent-sources/minecraft.ts` 部署后，面板把 `sources.minecraft.bots` 加上 `mc-bridge`；`/look` 需要 eye-server 的 `eye-server.mc.token`（见 [feiyuos-eye](https://github.com/YeStarOne/feiyuos-eye)）。

## 自测

```bash
cd bot
node run_cases.js            # wait/1.1 夹具（51 条 + 9 变异体）
node test-wait.js            # 真桥 wait 回归
node test-jobs.mjs           # /landmark /job 回归
```

## 红线

- 服务器端口只绑本机/Tailscale，**永不暴露公网**；离线模式下聊天栏名字≠身份。
- 旧生态端口 25565/25566 不碰；聊天栏不提内网地址。
- 改 bot.js 端点形状前先在平台仓群里打招呼（superagent source 在消费这些字段）。

## License

MIT（与 feiyu-os 一致）
