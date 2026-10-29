# Botmux 回合表情真实终态设计

日期：2026-10-29

状态：用户已确认继续按本方案修复

目标分支：`topic/capacity-wait-feedback`

## 1. 问题

`/th` 新话题会先启动 CLI，再提交用户任务。CLI 初始化期间可能产生一次
`working -> idle` 屏幕状态边沿；旧兼容表情逻辑把该边沿当成任务完成，将
GoGoGo 提前改为 DONE。真实日志证明 DONE 可比 `UserPromptSubmit` 早约 30 秒。

屏幕空闲只说明终端看起来可以输入，不能证明某个用户回合已经结束。完成表情
必须绑定到该消息对应的真实回合终态。

## 2. 目标行为

1. `screen_update` 的 `working/analyzing -> idle` 不再结算任何回合表情。
2. 只有当前 worker generation 上、匹配 session 与 turn 的 `turn_terminal`
   才能结算兼容表情。
3. `completed` 将该 turn 的 GoGoGo 替换为 DONE；其它终态将其替换为 ERROR。
4. type-ahead 中只结算 terminal 指定的 turn，其它 turn 保持原状态。
5. 没有可靠 `turn_terminal` 的兼容 CLI 保持 GoGoGo，不猜测 DONE。
6. 已持久化的真实会话继续使用现有 `TurnFeedbackRuntime`，不建立第二套状态源。

## 3. 方案

`pendingAckReactions` 仅保留给无法写入当前 SessionStore owner row 的兼容入口，
每项增加 `turnId`。screen idle 不再调用批量完成函数；worker-pool 在已有的
stale-worker、sessionId 与 generation 校验之后，按 terminal 的 `turnId` 调用
兼容结算函数。结算函数只摘除匹配项并保持其余项。

真实 daemon session 的 admission、恢复、needs_user、容量等待和 terminal
继续由现有持久 reconciler 负责。兼容结算不持久化、不重放，也不改变既有
terminal ownership。

## 4. 错误与恢复

- 飞书删除旧表情或添加终态表情失败仍为 best-effort，不影响 terminal 主流程。
- duplicate terminal 找不到 pending 项时 no-op。
- `silentTurnReactions` 在 terminal 时只移除收到表情，不添加 DONE/ERROR。
- daemon 重启会丢失兼容内存项；这是原兼容路径边界，不扩大为持久协议。

## 5. 验收

- `/th` 冷启动的 `working -> idle` 后仍无 DONE。
- exact completed terminal 后只有对应消息为 DONE。
- exact failed/ambiguous terminal 后只有对应消息为 ERROR。
- type-ahead A/B 中 A terminal 不结算 B。
- 持久反馈状态机与相关回归测试通过，build 通过。
- 新固定 SHA 经非作者限定复核后才可进入集成/发布流程。

