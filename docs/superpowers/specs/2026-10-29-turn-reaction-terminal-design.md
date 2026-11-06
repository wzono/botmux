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
5. 没有可信持久 ownership 的兼容入口保持 GoGoGo，不猜测 DONE 或 ERROR。
6. 已持久化的真实会话继续使用现有 `TurnFeedbackRuntime`，不建立第二套状态源。

## 3. 方案

删除 `pendingAckReactions` 及 screen-idle 批量完成路径。无法写入当前
SessionStore owner row 的兼容入口可以 best-effort 添加 GoGoGo，但因为没有
可信的持久 turn/attempt/generation ownership，不再尝试把它改成 DONE 或 ERROR。

真实 daemon session 的 admission、恢复、needs_user、容量等待和 terminal
继续由现有持久 reconciler 负责。兼容结算不持久化、不重放，也不改变既有
terminal ownership。

## 4. 错误与恢复

- 飞书删除旧表情或添加终态表情失败仍为 best-effort，不影响 terminal 主流程。
- duplicate terminal 找不到 pending 项时 no-op。
- `silentTurnReactions` 在 terminal 时只移除收到表情，不添加 DONE/ERROR。
- 兼容入口的 GoGoGo 是 best-effort、非持久状态；这是原兼容边界，不扩大协议。

## 5. 验收

- `/th` 冷启动的 `working -> idle` 后仍无 DONE。
- exact completed terminal 后只有持久反馈行对应的消息为 DONE。
- exact failed/ambiguous terminal 后只有持久反馈行对应的消息为 ERROR。
- type-ahead A/B 通过逐 turn 持久反馈行独立结算。
- 持久反馈状态机与相关回归测试通过，build 通过。
- 新固定 SHA 经非作者限定复核后才可进入集成/发布流程。

