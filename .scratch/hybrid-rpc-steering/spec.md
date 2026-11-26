# 运行中消息纠偏

Status: claimed

## 目标与验收

TraeX 与 Codex hybrid RPC 的普通即时用户消息，在已有原生任务仍运行时通过严格 `turn/steer` 接入当前任务。用户的纠偏在客户端处理下一次输入时生效，不再由 Botmux 固定等到旧任务结束才派发。原生工具无法在其不可打断阶段即时改变已发生的副作用。

1. 空闲时仍 `turn/start`；运行时只在已知当前 native turn ID、已确认投递、无终态结算或不明投递的条件下允许 `turn/steer`。
2. 成功 ACK 的纠偏加入同一个原生执行组。Engine 原生终态回调覆盖全部已接受输入；daemon 沿用 `thinking_superseded` 对被并入的输入结算，最后输入交付一次 final 与 terminal，避免重复结算。
3. 等待 start/steer 响应、终态先于响应、连续纠偏、拒绝、未知 ACK、CLI 退出均有相称行为测试。确定拒绝保留输入，未知投递不自动重发。
4. 显式排队、定时任务、持久 dispatch attempt、串行群、权限干预与现有跨身份控制不因该修正开放；TUI、其它 CLI、模型与配置默认值沿用现状。
5. 完成构建、定向回归和非作者复核；保存状态与上线状态分开报告。

## 已确认原因

线上 `5e6b50030dfa19304e4d8489aaf664e57a700e75` 与开发基线 `da089a41702ff65cff3ad10f6694f5f7fa2be981` 的相关实现相同。本机全局 dashboard.codexRpcInput=true。TraeX adapter 已 supportsTypeAhead=true，但 trusted-session-controller 强制后排队、worker active RPC 栅栏、写入前禁止 active native turn/start、engine 仅实现 turn/start 共同保证串行。

TraeX 0.216.0 生成类型与隔离真实 app-server 请求证明 `turn/steer` handler 存在，参数 `{threadId,input,expectedTurnId}`，响应 `{turnId}`。原生成功模型路径单独用本地测试 provider 验证；未验证部分保持 unknown。

2026-11-24 隔离原生成功探针已 exit=0：本地 Responses stub 的第一请求不含纠偏、第二请求含纠偏，steer ACK 与 activeTurnId 相同，turn/started 和 turn/completed 各一次。证据 `~/temp/traex-native-steer-local-result.json`，脚本 `~/temp/traex-native-steer-local-probe.py`。模型流量仅 loopback；客户端后台 CONNECT 外部站点被本地代理 502 阻断。

## 文件职责

- `src/codex-rpc-engine.ts`：RPC 投递、原生执行组、响应与终态竞态。
- `src/worker.ts`：输入栅栏、严格 steer 调用、桥接投递与终态归因。
- `src/core/trusted-session-controller.ts`：保留用户选择的群串行，取消已被新能力取代的 TraeX 传输串行规则。
- engine、worker、group-routing 的对应行为测试；现有同轮 transcript 测试用于回归。

## 实施与验证清单

- [x] 定位线上路径、客户端能力与工作区。
- [x] 先写失败测试，实现 engine 严格 steer 与执行组。
- [x] 先写失败测试，接入 worker 与 daemon 投递策略。
- [x] 本地 provider 的真实客户端成功路径、集成测试、构建与非作者 R1 复核。
- [ ] 保存提交和交付产物；按实际授权完成发布或说明待发布范围。

## 自测覆盖矩阵

| 验收项 | 行为与必要调用链 | 可复现证据 | 当前结果 |
| --- | --- | --- | --- |
| C1 运行中纠偏 | daemon/sendWorkerInput → shouldQueueAfterActiveTurn → worker input guard → engine turn/steer | group-join-shared-routing、worker-hybrid-rpc-steering、engine-steering；真实本地 TraeX integrated smoke | 通过；最后修正后再冻结 |
| C2 合并归因与终态 | ACK/bindNativeSteer → bridge mark/ingest → cot superseded → emitReadyCodexTurns → daemon accepted-input settlement | 新 worker 的 real engine + real queue + real worker lifecycle 测试；同轮 transcript 测试；engine 16 项 | 通过；只从最后输入输出一次 |
| C3 响应/终态竞态与不重发 | request/onMessage/steerInFlight → awaiting/activation/hydration → teardown | native ACK 前终态、stale-idle hydration、onDead 同步 teardown、错误 ACK、超时和两关键 guard 变异 | 通过；未知结果保持不自动重投 |
| C4 既有输入边界 | groupSerialInput/schedule/durable/XPI → pending input policy；raw/rename 等待与普通纠偏交叠；schedule 前缀与 owner 纠偏提升 | input-gate、pty-input-policy、worker-queue-merge、新 worker 边界测试；promotion 必要链路纳入独立复核 | 已补管理输入交叠，代码冻结待 R1 |
| C5 原生消费回执 | worker ACK → native_input_consumed IPC → worker-pool → group-context store | native-input-receipt 两文件 23 项；steer coverage 持久化和 stale generation 拒绝 | 通过 |
| C6 编译与真实客户端 | ts build/typecheck；实际 engine → TraeX 0.216.0 app-server → loopback Responses provider | bun run build exit 0；traex-hybrid-engine-local-result.json | 已通过；提交前最终重跑 |

2026-11-24 22:16 最终候选前的 14 个相关文件 415 项全部通过。独立审查分别覆盖 engine（未参与实现的验证 agent）与 worker/proof/controller（未参与这些文件实现的 engine agent）。上线状态仍未生效。

22:19 最后修正的 worker 及关联测试 5 文件 126 项通过，完整 build/typecheck exit 0；new worker 22 项。随后只读冻结：worker sha256 `0db8157a47685b1343bff44c37efc922ca1965bc3af544dcc3153f0b1439f57e`；engine 的冻结摘要由非作者 R1 核对。

## 独立复核与真实集成

Engine R1 approve：独立 78 项回归、3 个异常组合探针和真实 TraeX + patched engine + loopback provider integrated smoke 均通过。报告 `~/temp/hybrid-rpc-steering-engine-r1.md`，engine sha256 `d1da097d99ecf5acbcdf770ff13b6f718850d13246fb244922f4c3c33b75e807`。

Worker R1 approve：独立 6 文件 216 项（含 2 个 R1 额外交叠探针）通过；schedule 前缀 + owner 纠偏、等待 ACK、3 次连续纠偏 + 长窗口均通过。cot superseded lease 退休守卫变异咬红，恢复后 3 个 R1 探针通过。报告 `~/temp/hybrid-rpc-steering-worker-r1.md`。

当前仅本地已保存、已构建、已验证、已复核；线上切换必须使用维护的独立 release 与全量 gate。

## 复核约定

R1 完整目标与必要调用链复核，R2 仅验证 P0/P1 修正和相关回归，R3 由目标决策者终局裁决。范围仅运行中普通输入纠偏及所需调用链；不扩展模型策略、发布架构、客户端升级或跨身份权限。
