# Hybrid RPC engine 验证

2026-11-24。验证对象为 `src/codex-rpc-engine.ts` 与 `test/codex-rpc-engine-steering.test.ts`。

## 行为覆盖

- 精确 `expectedTurnId` 的两次连续纠偏；已接收 root 和纠偏输入按顺序各结算一次。
- completion 先于 steer ACK 时缓冲；明确拒绝仅结算原组，未接收纠偏不获得终态。
- 原生错误 -32601 关闭该 engine steering，保留后续 serial start。
- 错误/缺失 native ID、通用 server failure、超时均为 ambiguous；禁止自动重发。
- socket 未发送时不调用提交 hook；过期/外来 ID、重复输入、并发纠偏均不派发。
- stop/death 保留 root 与已接收成员，未 ACK 成员只返回 ambiguous；已缓冲的 completed 不被 teardown 改写。
- ACK 与 native question 同 socket read 时，问题使用最新 accepted owner；终态回调重入不能在旧组尚未结算完时启动新轮。

## 红绿证据

- 初始 11 个用例对未实现 engine 全红，原因为缺少 canSteer/steerTurn。
- 增补 completion+stop、ACK+question 同 read、terminal callback 重入用例分别复现实际 race；修正后新文件 16/16 通过。
- engine 旧测试 62 项与新增 15 项的完整回归 77/77 通过（22:10:31，39.45s）；随后新增重入用例，新文件 16/16 通过（22:12:27）。最终全量按提交前验证重跑。

## Guard 变异复验

独立复制：`~/temp/hybrid-rpc-steering-engine-mutation-20261124`，用 apply_patch 修改副本，主工作树未变异。每次测试通过 `bun scripts/fenced-run.ts` 运行。

1. 删除 bindNativeSteer 的 nativeTurnId !== expectedTurnId 守卫；`-t 'fences a'` 返回 exit 1，2 项因非法 ACK 被当成成功而失败（22:13:30）。
2. 将 completion defer 守卫改成 false；`-t 'buffers completion before'` 返回 exit 1，观察到 root 在 ACK 前提前收到 completed（22:13:39）。
3. 恢复两个守卫；新测试文件 16/16 通过，exit 0（22:13:52）。

准确命令：

```sh
rtk proxy bun scripts/fenced-run.ts -- bun node_modules/vitest/vitest.mjs run --project unit test/codex-rpc-engine-steering.test.ts -t 'fences a'
rtk proxy bun scripts/fenced-run.ts -- bun node_modules/vitest/vitest.mjs run --project unit test/codex-rpc-engine-steering.test.ts -t 'buffers completion before'
rtk proxy bun scripts/fenced-run.ts -- bun node_modules/vitest/vitest.mjs run --project unit test/codex-rpc-engine-steering.test.ts
```

尚未证明真实模型正在运行时纠偏的采样时延。此文件记录 transport/lifecycle 验证，不把协议 handler 存在当作真实模型端到端完成。
