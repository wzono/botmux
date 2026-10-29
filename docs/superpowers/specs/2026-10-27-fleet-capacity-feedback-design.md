# Botmux 全量可信容量反馈设计

日期：2026-10-27；2026-10-28 收窄恢复保证；2026-10-29 用户确认 shared/adopt 例外

状态：收窄设计与 shared/adopt 例外已由用户确认

目标分支：`topic/capacity-wait-feedback`

基线：定制版 `dev@f1b6f85ec`

## 1. 结论

容量反馈作为一个独立 topic 进入定制版 `dev`。全部 Botmux 机器人运行同一份代码，并最终启用同一套逐 turn 状态、Dashboard、飞书工作卡、表情和提醒能力。

本功能只保证**反馈状态自身**的持久化与收敛：逐 turn 行或 reaction intent 一旦成功写入 SessionStore，daemon 重启后必须继续恢复；provider ACK 不确定时，必须先读取自身 reaction 再决定下一步，不能盲目重发。它不接管 Botmux 的完整 terminal lifecycle，也不承诺 terminal 在首次 SessionStore 终态提交前恰好发生 daemon/worker 崩溃时无损恢复。

发布不再限定单个机器人。采用“统一 release、按可信信号路径分批启用、最终全量”的策略：先验证 TraeX 原生信号，再验证 Codex/Claude Proxy sideband，最后覆盖剩余机器人。分批仅用于控制发布风险，不形成长期版本或能力分叉。

旧的 Evan-only 候选二进制、端口、系统身份和发布清单均为历史材料，不得执行。未通过完整规格审查的 Task 3 提交 `418dcf172` 也不得进入 `dev`、候选构建或发布；新版实施前须先可恢复地撤销该提交。

## 2. 背景与现状

当前定制版 `dev` 已有两项基础行为：

- 识别部分 `Queued for capacity` 终端形态，避免错误判断 CLI 已空闲。
- 普通处理/结束表情（例如 GoGoGo、DONE）。

它还没有以下完整能力：

- 把明确容量等待建模为逐 turn 持久反馈；成功写入 SessionStore 后可恢复。
- 展示排位、观测时间和“尚未开始执行”。
- 在 Dashboard、飞书工作卡与触发消息表情之间保持一致。
- 在交互任务 2 分钟、后台任务 10 分钟时更新一次提醒。
- 消费 Codex/Claude Proxy 产生的签名结构化排队事件。
- 对误报提供按机器人、按 adapter 的持久 kill switch。

已有实现保存在三个本地分支中：

- Botmux 状态基础：`feat/capacity-state-feedback@2c9159778`
- Botmux sideband consumer：`feat/capacity-sideband-consumer@15fb7755f`
- Proxy sideband producer：`feat/capacity-sideband@cafb196a`（v2 参考实现）

这些分支相对当前 `dev` 带有大量历史差异，不能整体合并。实施时只移植经新 spec 要求的功能，并用测试先行重新建立行为证据。

当前 topic 已完成两个通过独立规格与质量审查的实现阶段：纯状态机 `92b354729`，以及 exact-turn admission 到 `98b0c308d`。后续 Task 3 曾把范围扩大到 worker terminal outbox、两阶段 suspend 与完整 terminal lifecycle 恢复；完整规格审查证明这需要贯穿 ordinary、queued、Codex、VC、readonly、recovery 六类入口的独立协议，因此本需求明确放弃这部分扩展。

当前 fleet 有 29 个机器人；运行时配置归一为 5 个 TraeX、11 个 Codex、13 个 Claude Code。部分 Codex/Claude 走共享 Trae Proxy，部分走直接订阅或 Relay。功能必须部署到全部 29 个机器人，但只有收到权威容量信号时才能进入“等待模型容量”；不能为了覆盖率从静默或普通文本猜测排队。

## 3. 目标与非目标

### 3.1 目标

1. 全部机器人使用同一 `dev` release 和同一状态模型。
2. 明确容量等待在 5 秒内出现在 Dashboard 或飞书工作卡。
3. 状态严格绑定 `app + session + turn + attempt + worker generation + native identity`，不能串到别的机器人或任务。
4. 在能证明源 turn/attempt/worker generation 的普通、显式 Ask 和受管 RPC 路径中，排队、等待用户、处理中、完成、失败的表情和卡片状态一致；已成功写入 SessionStore 的反馈状态和 reaction intent 可在 daemon 重启后恢复。
5. 误报时只关闭对应 `机器人 × adapter`，其余机器人继续工作。
6. 每日定制版重建能从 manifest 恢复该 topic，不依赖 stash 或 live checkout 的未提交文件。

### 3.2 非目标

- 不自动切模型、推理档或供应商。
- 不停止并重放当前任务。
- 不把思考、工具执行、限流、额度不足或普通无输出统称为容量排队。
- 不记录 prompt、模型回答、终端屏幕原文或队列错误正文。
- 不要求没有权威排队信号的 provider 伪造排位。
- 不长期维护 Evan-only 或其它单席二进制。
- 不新增 worker terminal outbox、daemon terminal lifecycle store、opaque attempt reference 或 terminal effect receipts。
- 不修改 ordinary、queued、Codex、VC、readonly、recovery 六类入口的既有 terminal ownership。
- 不承诺 terminal 在首次 SessionStore 终态提交成功前恰好发生 daemon/worker 崩溃时无损；该窗口沿用 Botmux 现有行为。
- 不为本功能新增两阶段 suspend、Web Terminal 写栅栏或完整 terminal lifecycle 重放。
- 不为缺少 source-bound worker generation 的 shared-service / adopt hook 新增跨进程 Ask 代次协议。这两类特殊路径仍正常发布和回答 Ask，但容量反馈保持原状态，不投影 `needs_user`；不得从查询时的 current Session/worker generation 猜测事件归属。

## 4. 方案选择

### 4.1 采用：统一 dev，分批验证后全量

所有机器人运行同一份 Botmux release。可信检测通过 fleet policy 分批开放；每批通过后继续，最终所有现有及新建的受支持机器人默认启用。

优点：没有长期版本分叉；能逐批归因和回滚；最终符合全量生效目标。代价：需要一个明确的 rollout policy 和分组回读。

### 4.2 拒绝：一次性全量

代码最简单，但首个错误归属或误报会同时影响整个 fleet，无法快速判断是 TraeX、Codex、Claude 还是 Proxy producer 的问题。

### 4.3 拒绝：长期单席或多版本

隔离风险最强，但会让定制版维护、每日重建和线上回滚同时维护多套 release，不符合用户确认的全量目标。

## 5. 模块与接口

设计使用五个深模块。调用者只接触小接口；文件系统、签名、恢复和状态机复杂度留在各模块内部。

### 5.1 `TurnFeedbackRuntime`

接口：接收规范化的 `waiting | clear | terminal | needs_user` 观测，并投影当前 turn 的持久状态。`terminal` 仍由现有 live worker/daemon 路径提供，不成为本模块新建的跨重启事实源。

职责：

- 验证 exact turn/attempt/generation。
- 持久化状态与恢复义务。
- 统一投影 Dashboard、飞书工作卡、表情和提醒。
- 对 position-only 更新做 15 秒 trailing refresh；状态边沿立即刷新。

它不知道 TraeX viewport、Proxy 文件或签名格式。

### 5.2 `ReactionProjection`

接口：`reconcile(target, desiredReaction)`。

职责：

- 在 provider CREATE/DELETE 前，先把 immutable operation intent 写入 SessionStore。
- 通过完整 own-reaction 列表收敛为最多一个目标表情；不同类型的旧表情也必须清理。
- provider ACK 不确定、ID 持久化失败或 daemon 重启时，从已落库 intent 恢复；先 LIST，再决定 adopt、DELETE 或 CREATE。
- 保留 1s/5s/15s 的短暂恢复，以及 5m/30m/2h 的受阻恢复；永久错误不盲目重试。
- 只恢复已经成功写入 SessionStore 的 intent；它不持久化、重放或接管 terminal 事件本身。
- live terminal 到达时，反馈终态与 reaction intent 应在同一 SessionStore mutation 中提交；该 mutation 失败时跳过本次反馈 reaction、记录明确错误，但不阻断或重放 Botmux 原有 terminal lifecycle，也不伪造可恢复成功。

### 5.3 `CapacityEvidenceAdapter`

接口：把某个 CLI 路径的权威信号转换为规范化观测，并附带 native identity 和观测时间。

首版 adapter：

- TraeX：只读取当前 viewport 中与最新 composer 相邻的权威容量 UI，绑定当前 revision/turn/attempt。
- Codex/Claude Proxy：只读取已验证的 fleet `capacity-wait.v3` sideband；旧 `v2` 不进入全量 consumer。
- 其它直接 provider：仅在该 CLI 暴露同等强度的权威结构化事件或当前 UI 时增加 adapter。未适配时保持 processing，不从文本、日志或静默推断。

### 5.4 `FleetCapacitySideband`

接口：Proxy 发布签名事件；每个 Botmux daemon 只消费自己 app 命名空间中的事件。

职责：签名验证、owner 路由、claim、重放保护、checkpoint、pending/quarantine、恢复和逐 adapter fail-closed。

### 5.5 `CapacityRolloutPolicy`

接口：`isEnabled(appId, adapter)`、`disable(appId, adapter, reason)`、`phase()`。

职责：

- 统一代码下的分批启用。
- 最终默认开启受支持 adapter，使新机器人无需另建版本。
- 持久保存 `机器人 × adapter` kill switch。
- 提供 fleet emergency off，但正常误报不得使用全局关闭。

## 6. 状态模型与用户体验

每个 turn 最多有一个当前反馈状态：

| 状态 | 触发 | 表情 | 展示 |
|---|---|---|---|
| processing | 已接纳、未出现其它权威状态 | GoGoGo | 正在处理 |
| capacity_waiting | 权威容量事件 | Coffee | 等待模型容量；有排位则展示排位与更新时间 |
| needs_user | 已发布且可回答，并能证明源 turn/attempt/worker generation 的 Ask/TUI | THINKING | 等待用户操作 |
| completed | 当前 turn 成功结束 | DONE | 已完成 |
| failed | 当前 turn 失败 | ERROR | 失败及既有安全错误摘要 |

优先级为 terminal > needs_user > capacity_waiting > processing。`needs_user` 解除后，如果同一 turn 的容量等待仍有效，则恢复 Coffee；权威进展、clear 或 terminal 才清除容量等待。

用户已明确接受 shared-service / adopt hook 的展示例外：这两类路径没有可信的 source-bound worker generation 时，Ask 卡仍可发布、作答和回传，但反馈 ownership 必须 fail closed，不得切换 THINKING，也不得在回答后清理另一代 worker 的 attention。该例外只收窄容量状态展示，不改变 Ask 的投递、答复和业务结果。

旧排位在 60 秒没有新权威观测后变为 stale，并隐藏具体排位；不能继续显示一个看似实时的旧数字。clear、terminal、关闭会话或 adapter kill switch 会立即清除相关卡片、Dashboard 状态、表情和提醒。

提醒仅原地更新当前工作卡：交互任务连续等待 120 秒，后台/定时任务连续等待 600 秒。一个连续 episode 每个阈值只产生一次提醒意图；不刷消息，不把 Dashboard 刷新算作用户可见回执。

## 7. Fleet sideband 协议

### 7.1 事件

从单 app 的 `capacity-wait.v2` 演进为 fleet 版 `capacity-wait.v3`：

- `owner_app_id`
- `adapter`
- `signer_key_id`
- `signer_epoch`
- `native_session_id`（需要时）
- `native_turn_id`
- `request_id`
- `queue_id`（可选）
- `state = waiting | clear | terminal`
- `position`（waiting 且已知时）
- `observed_at`
- 全局单调 `sequence`
- Ed25519 `signature`

事件不含 prompt、回答、原始上游正文、chat/message/open ID 或凭据。

### 7.2 owner 传播

旧实现用 Proxy 静态 `CapacitySidebandAppID`，只能服务一个机器人。全量方案不接受调用者自由填写 owner header，而由 Proxy 根据已认证的 per-bot access key 的不可逆 caller-scope 映射 `owner_app_id`：

- Botmux fleet 为使用受管 loopback Trae Proxy 的机器人配置独立 access key；Proxy 侧只保存 `caller_scope -> owner_app_id` 映射，不在 owner 表重复保存明文 key。
- Proxy 根据已验证 access key 查 owner，并对照由 Botmux fleet 配置生成、带哈希回读的 allowlist；调用方传入 owner header 时直接拒绝，不能覆盖映射。
- 外部 provider 和未登记 access key 不产生 sideband。
- access key 负责请求归属，Ed25519 signer 负责事件完整性，两者用途不混用；Botmux 仍须把签名 owner 与 exact native binding 再次匹配。
- 同 UID 的恶意宿主进程窃取其它机器人的 access key 不在本功能的安全边界内；该场景需要另行做进程/系统身份隔离。事件 signer 私钥仍不下发给 worker。

### 7.3 目录与消费

共享 root 下按 owner 分目录：`owners/<owner_app_id>/events`。Proxy signer 可发布，Botmux host 可 claim/ACK；worker 不持私钥。

每个 daemon 只打开自己的 owner 目录，并使用独立 checkpoint。错误 owner、错误 native identity、旧 attempt/generation、重复 sequence、无匹配 binding 的事件均不得投影：

- 合法但暂未匹配：保留为有界 pending，等待 binding 恢复。
- 签名/shape/权限错误：quarantine 并关闭该 app 的对应 adapter。
- owner 不属于当前 daemon：不 claim，不移动，不改 checkpoint。

这消除旧共享目录中“错误 daemon 先 claim 再 pending”的跨进程竞争。

### 7.4 恢复与密钥轮换

- daemon restore 完成后再启动 consumer。
- persisted binding 必须重新验证 session、turn、attempt 和 generation。
- `signer_key_id + signer_epoch + sequence` 抵抗重试、时钟回拨和密钥轮换；checkpoint 按 signer epoch 分区。
- 轮换期间可配置当前与上一把公钥；上一把只接受轮换前 epoch，不能无限期保留。

## 8. 启用策略与全量含义

“全部机器人生效”定义为：

1. 29/29 机器人运行同一含本 topic 的 `dev` release。
2. 29/29 都使用同一状态框架、投影逻辑和 kill-switch 机制。
3. 受支持 adapter 默认开启；有权威信号时均能展示容量等待。
4. 没有权威信号的 provider 保持 processing，并在状态页显示 `capacity signal unsupported`，而不是伪造 waiting。

最终 policy 不保留 pilot allowlist。临时分批开关只属于发布过程；新建的 TraeX、Codex 或 Claude Code 机器人在匹配受支持信号路径时自动启用。

## 9. 分批发布

发布以实际运行配置动态生成成员清单，不把“29”写死在代码里。

### Batch 0：统一代码，投影关闭

- Proxy 先部署 signer 与 owner 命名空间，但不改变用户展示。
- Botmux 统一 release 发布到全 fleet，capacity rollout phase 为 shadow。
- 验证所有 daemon、Dashboard、普通 turn、Ask、完成和失败路径没有回归。

### Batch 1：TraeX

- 开启所有 TraeX 机器人。
- 验证 waiting、position update、stale、clear、terminal、重启恢复和普通文本反例。

### Batch 2：Trae Proxy-backed Codex/Claude

- 开启能提供 exact native identity 的 Codex/Claude 路径。
- 验证 owner 传播、签名、app/session/turn/attempt/generation 绑定、流式与非流式响应、重放和错误 owner。

### Batch 3：剩余机器人

- 对已有权威 adapter 的剩余机器人开启投影。
- 对没有权威信号的路径启用统一框架并明确标记 unsupported；不得宣称发生过排队验证。
- 回读全部机器人同一 release，且 rollout policy 不再保留 pilot allowlist。

每批出现一次经人工确认的误报，立即持久关闭对应 `app × adapter`。其它 app 和 adapter 不受影响；修复、重新验证和显式批准后才能恢复该格。

## 10. 测试与验收

### 10.1 测试先行

每个行为先写失败测试并确认因缺失功能而红，再实现最小代码。不得把旧分支实现复制进来后补测试。

重点测试：

- 状态转换、优先级、stale、提醒幂等和恢复。
- current viewport 正例及 quote/prose/tool/thinking/旧屏幕反例。
- 29 个 daemon 并发消费时只由 owner daemon claim。
- 错 app/session/turn/attempt/generation、重放、乱序、clock rollback 和 key rotation。
- kill switch 只影响一个 `app × adapter`。
- restart、checkpoint 写失败、pending 恢复、目录/文件权限和 symlink/rename race。
- Dashboard、工作卡和 reaction 的实际投影行为；不以源码文本断言代替行为测试。
- Ask/TUI 投影必须覆盖带 source-bound generation 的普通、显式和受管 RPC producer；shared-service / adopt hook 缺 generation 时验证 Ask 仍可回答、反馈保持原状态且不会串到当前 worker。
- reaction intent 写入后模拟进程死亡：重启只能从该 intent 恢复，必须 LIST-before-mutate，且不能重复 CREATE/DELETE。
- terminal 首次 SessionStore 提交失败窗口只验证“不会冒称已恢复”，不为此创建 outbox、attemptRef 或跨入口 lifecycle 协议。
- 留存规则：非终态和任何未解决反馈义务永不裁剪；已收敛终态保留 7 天／最新 512，永久诊断保留 7 天／最新 128；10,000 行夹具验证精确结果且不修改输入。

### 10.2 代码门禁

- Botmux focused tests、TypeScript、完整 build。
- 定制版 manifest 重建与相关维护测试。
- Proxy focused tests、race、vet、build 和支持平台编译。
- 当前冻结上游的全量测试对比，不新增失败。
- 非作者分别复核 spec/standards 与 correctness/security；有 blocker 必须修复后重新冻结范围。

### 10.3 线上批次验收

- 明确排队首次外部可见 <= 5 秒。
- 排位更新不超过 15 秒 trailing window。
- clear/terminal/kill switch 立即撤销 waiting。
- 思考、工具执行、普通静默和用户引用排队文案均为 0 误报。
- 跨机器人、跨 session、跨 turn 和旧 attempt 均为 0 串线。
- 最终 29/29 online、同一 release、Dashboard healthy；实际数量变化时以实时 fleet 为准。
- 验收记录必须明确：反馈恢复保证从 SessionStore 成功写入开始；首次 terminal 持久化前的 daemon/worker crash 窗口不在承诺内。

## 11. 回滚

回滚分四层，优先使用影响最小的一层：

1. `app × adapter` kill switch：误报或局部 source failure。
2. fleet adapter off：某个 producer/adapter 系统性异常。
3. capacity projection global off：保留普通 Botmux 功能，只隐藏容量反馈并清理已投影状态。
4. release rollback：回到上一个健康定制版 release；Proxy sideband 可独立关闭。

每层回滚都必须清理 live waiting/stale、表情、卡片和提醒，同时保留终态与普通任务执行。不得通过重放原任务验证回滚。

## 12. 仓库与维护

- Botmux 功能放在 `topic/capacity-wait-feedback`，从当前 `dev` 重建。
- topic 通过门禁后加入 `~/project/botmux-custom/manifest.json`；每日重建按依赖顺序合成。
- Proxy producer 保持独立功能分支并进入其正式维护清单。
- 不修改 release 目录；release 只由现有发布工具生成。
- 历史 Evan-only `RELEASE.md` 仅作审计证据，不得作为新发布输入。
- Task 3 提交 `418dcf172` 只保留为失败实验与审查证据，实施前通过 `git revert 418dcf172` 生成可追溯撤销提交；禁止 reset、改写历史或从其中整体 cherry-pick。
- 完整 terminal lifecycle 若未来重开，必须另立 spec，定义 opaque attemptRef、六类 owner adapter、逐 effect durable receipt 和迁移策略；不得悄悄回流本 topic。

## 13. 设计自检

- 无占位项或依赖用户补充的未决项。
- 全量目标与分批节奏已分离，不再把 canary 误写为最终范围。
- “所有机器人具备功能”与“没有权威信号时不猜测排队”没有冲突：统一框架全量生效，waiting 只由可信 evidence 触发。
- sideband 从单 app 静态配置改为 owner 命名空间，解决多 daemon 竞争和跨机器人串线。
- feedback restart recovery 与完整 terminal lifecycle recovery 已明确分界，不再把后者当成本功能的隐含保证。
- 所有完成标准都有对应测试或线上回读门禁。
