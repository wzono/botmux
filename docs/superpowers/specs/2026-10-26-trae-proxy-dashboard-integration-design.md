# Trae Proxy Dashboard 融合与目录自动同步设计

## 状态

- 设计日期：2026-10-26
- 设计状态：已完成逐段确认，待书面规格复核
- 实现状态：未开始
- 方案选择：插件原生融合（方案 A）

## 目标

把现有 Trae Proxy 模型状态能力收敛为两个正式入口：

1. Botmux Dashboard 左侧导航中的独立 Trae Proxy 板块；
2. Botmux 控制中心群里唯一一张置顶飞书状态卡。

最终系统必须同时解决以下问题：

- Dashboard 页面自动刷新，不再跳转到独立的 9362 Web 页面；
- TraeX 目录中的全部可路由模型自动开放到 Proxy，不再靠手工维护静态清单；
- 新模型、待下线模型、已下线模型都有可追溯状态；
- 自然业务样本和主动探针样本分别采集、分别展示；
- 低频模型能在有限资源预算内更快形成可参考的 TTFT 数据；
- 路由同步、探针、Dashboard 和飞书卡片各自失败时不互相拖垮。

## 非目标

- 不把 Trae Proxy 状态绑定到某个 Botmux 机器人或个人订阅；
- 不恢复或继续发布另一个 Botmux 容量排队反馈项目；
- 不把 9362 服务整体塞进 Botmux daemon 进程；
- 不把探针样本伪装成自然业务样本；
- 不在飞书群内暴露 Dashboard token、Proxy API key、Trae 凭据或内部回调 token；
- 不把 TraeX 目录中缺少可用 backend metadata 的条目静默当成已开放。

## 已确认决策

- 采用插件原生融合，不使用 iframe，也不把全部逻辑写进 Botmux 核心。
- Botmux 已有的 pinned plugin Dashboard 机制作为左侧固定入口；不新增写死的 Trae 专用导航代码。
- 9362 继续承载内部采集、API、探针和飞书回调，但只监听 127.0.0.1，不再提供用户可访问的独立网页。
- TraeX model/list 是目录权威源；Proxy 必须开放目录中每个具有可用 backend metadata 的模型。
- 现有手工兼容别名继续保留，目录同步不得覆盖或删除它们。
- 目录模型连续 3 次成功刷新均缺失后进入待下线；24 小时仍未恢复才永久移除；历史保留 7 天。
- 允许主动探针，采用单并发、自适应频率、高负载暂停和失败退避。
- 控制中心群只有一张置顶卡；更新原卡，不重复发消息。
- 发布先只读观察，再开启自动路由和探针；每步都能独立回滚。

## 现状与根因

### 已有能力

- Trae Proxy 在 127.0.0.1:8317 提供模型路由。
- trae-model-status Botmux 插件的内部服务在 9362 提供快照、SQLite 样本、Card 2.0 和回调。
- Proxy 的 trae-model-status-usage usage sink 会把白名单字段写入 9362。
- 独立 Web 页面每 5 秒读取一次 /api/snapshot。
- 插件 Dashboard contribution 已经存在，但当前只显示服务状态和打开网页按钮。
- Botmux 已支持插件 Dashboard、左侧 pinned plugin、Card 2.0 发卡和插件回调。

### 当前缺陷

1. proxyRoutes 只在 9362 服务启动后的第一次刷新读取，后续配置变化不会被发现。
2. newModels 是硬编码数组，不能反映真实目录新增和下线。
3. Proxy 路由本身是 AIKit 模板里的静态清单，TraeX 目录变化不会自动进入 Proxy。
4. 当前只有请求真实经过 8317 才产生样本；低频路由长期没有数据。
5. 等待区间只认最近 24 小时内至少 20 条成功且 TTFT 大于 0 的记录，导致大量模型长期显示校准中。
6. 数据库累计记录很多，但高度集中在 GPT-5.6 Sol 和 GPT-6.1 Sol；这不是采集服务失效，而是实际流量分布不均。
7. 飞书卡片只有话题消息，没有控制中心固定入口。

## 总体架构

~~~text
TraeX model/list（30 秒刷新）
           │
           ▼
Catalog Reconciler ──► Catalog / route state（SQLite）
           │                    │
           │                    ├──► Adaptive Probe Scheduler
           │                    │             │
           │                    │             ▼
           │                    │      Trae Proxy :8317
           │                    │             │
           │                    │             ▼
           │                    └──► Usage sink ──► observations
           │
           ▼
Managed route candidate ──► isolated validation ──► guarded Proxy switch

Internal status service :9362（loopback only）
           │
           ├──► Botmux same-origin plugin service bridge
           │             └──► pinned Trae Proxy Dashboard（5 秒刷新）
           │
           └──► Botmux plugin status-card publisher
                         └──► 控制中心群唯一置顶卡
~~~

职责边界：

- Botmux 核心只提供通用的、受限的插件服务桥与插件状态卡发布能力；
- trae-model-status 插件负责目录状态、样本、探针、页面模型和卡片渲染；
- AIKit 负责把受管目录路由与手工路由可靠合并成 Proxy 配置；
- CLIProxyAPI 负责路由执行、TTFT 和 usage 上报、探针来源标记和候选验证。

## Botmux Dashboard 融合

### 固定入口

trae-model-status 继续声明插件 Dashboard contribution，并在发布时把 trae-model-status 加入 dashboard.pinnedPlugins。

Botmux 已有 pinned plugin 导航机制会把它放到左侧插件入口之后。显示名为 Trae Proxy，路由沿用插件路由，不写死在主导航枚举里。

### 同源插件服务桥

浏览器不能直接安全访问宿主机 127.0.0.1:9362。Botmux 增加一个通用的插件 Dashboard API：

~~~ts
api.requestService({
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
}): Promise<unknown>
~~~

插件 manifest 必须显式声明允许的 method 和 path：

- GET /api/snapshot
- POST /api/refresh

安全约束：

- 只允许已认证的 Dashboard 会话；
- 目标只能是当前已安装插件的 loopback service，不能传 URL 或 host；
- method 和 path 必须命中 manifest allowlist；
- 不转发浏览器 cookie、Authorization 或任意自定义凭据；
- 禁止重定向，JSON 响应上限 1 MiB，默认超时 3 秒；
- 不开放 /internal/usage、卡片回调和路由写操作；
- 每次请求记录 plugin id、path、状态和耗时，不记录正文或密钥。

### 页面行为

- 每 5 秒读取一次快照；页面隐藏时降为 30 秒，恢复可见时立即刷新。
- 每 30 秒由内部服务刷新 TraeX 目录，浏览器只读服务快照。
- 顶部展示最后一次目录成功时间、样本更新时间、Proxy 健康和数据新鲜度。
- 默认排序：异常和高负载 → 上新 → 常用 → 其他。
- 支持按展示名、目录 id、Proxy alias、真实 backend 搜索。
- 详情面板展示 24h 和 7d 自然样本、探针样本、P25–P95、失败率、最后观测时间和路由生命周期。
- 旧的独立 Web HTML、CSS、JS 删除；9362 根路径返回 404，不再生成 openUrl。

## TraeX 目录与 Proxy 路由自动对账

### 目录读取

- 每 30 秒调用 model/list，limit 为 100，forceRefresh 为 true。
- 只有完整、非空且通过 schema 校验的读取才算成功目录刷新。
- 超时、进程退出、空结果或结构异常只更新目录错误状态，不计作模型缺失。
- 每次成功目录生成稳定 hash；hash 未变化时不生成路由候选，也不触发重启。

### 模型身份和 backend 选择

- 目录 id 是直接路由的稳定 alias；展示名只用于 UI。
- 按机器当前 variant policy 选择 backend：优先 max，该模型没有 max 时使用 standard。
- 目录没有可用 backend key 时标记 unmapped/abnormal，立即显示和报警；不得静默遗漏，也不得编造 backend。
- context window、描述和能力信息优先取目录 metadata；缺少非路由必需字段时允许开放，但 UI 标注未知。

### 受管模型与手工别名分离

自动同步不直接改 AIKit 模板，也不修改 local.yaml 的手工段。新增机器私有受管文件：

~~~text
~/.aikit/cliproxy/managed/catalog-models.json
~~~

该文件 mode 0600，包含目录直接路由、生命周期、目录 hash 和生成时间。AIKit generateConfig 必须从当前文本拼接升级为结构化 YAML 合并，并按以下优先级合并模型：

1. 受版本控制的手工和兼容别名；
2. 机器私有受管目录路由；
3. 明确的本机手工覆盖。

合并规则：

- 手工 alias 优先，自动同步永不覆盖；
- 直接目录 alias 与手工 alias 冲突时保留手工项，并在 Dashboard 标记 conflict；
- 自动同步只能改受管文件；
- aikit compile、start、restart 都使用同一合并函数，避免后续编译覆盖；
- 每次候选写入前保留上一版本和 SHA-256，原子 rename 替换。

### 生命周期状态机

| 状态 | 进入条件 | Proxy 行为 | UI 行为 |
| --- | --- | --- | --- |
| available | 目录存在且路由验证通过 | 正常开放 | 正常展示 |
| new | 首次出现且验证通过 | 正常开放 | 上新标记保留 7 天 |
| pending_removal | 连续 3 次成功目录刷新均缺失 | 停止新请求选择和系统探针 | 显示缺失次数和 24h 倒计时 |
| removed | pending 24h 后仍未恢复 | 从受管活动路由永久移除 | 历史保留 7 天 |
| unmapped | 目录存在但没有可用 backend | 不开放 | 明确显示缺失 metadata |
| abnormal | 候选验证或切换失败 | 保持上一版本 | 显示错误和回滚结果 |

pending_removal 的暂停表示从活动路由广告和新请求选择中移除，但映射仍保存在受管状态和回滚快照中；模型在 24 小时内恢复时可无损复原。

## 路由变更安全执行

目录 reconciler 只生成意图，真正切换由独立的受管执行器完成：

1. 获取单实例锁，读取最新目录 hash、当前受管文件和当前 Proxy hash；
2. 生成候选受管文件和候选完整配置；
3. 校验 YAML、alias 唯一性、手工别名未变化、目录覆盖率和插件配置；
4. 用隔离端口启动候选 Proxy；
5. 验证 /health、/v1/models、预期模型数和新增模型最小真实调用；
6. 候选通过后原子替换受管文件，启动独立回滚守护，再只重启单个 Trae Proxy；
7. 验证生产 Proxy 健康、模型清单、usage sink 注册和 9362 健康；
8. 任一步失败恢复旧受管文件、旧配置和旧进程。

自动变更必须串行。新的目录变化在执行期间只合并为下一轮，不并发重启。候选验证请求标记为 probe 或 validation，不进入自然业务统计。

## 样本与主动探针

### 数据来源必须显式标记

SQLite observations 增加：

~~~text
sample_source: natural | probe | validation
probe_run_id: nullable string
~~~

旧记录迁移为 natural。探针请求使用专用本机请求标记；Proxy 只在 loopback 且已通过现有 API 鉴权时把该标记写入 request metadata，并在转发上游前剥离。Usage reporter 把 metadata 归一为 Record.Source，usage sink 只转发枚举后的 sampleSource，绝不转发 API key、原始 header 或 prompt。

不能从时间、模型名或调用者进程猜测样本来源。

### 展示口径

- 自然有效样本不少于 20：显示稳定区间，主值为自然 P25–P95。
- 自然有效样本 5 到 19：显示低置信区间，主值仍只用自然样本。
- 自然有效样本少于 5 且探针有效样本不少于 5：显示明确标注的探针参考。
- 其余情况显示校准中。
- 24h 与 7d 分开统计；自然、探针、validation 永不混算。
- 每个模型同时展示样本数、失败数、失败率和最后成功时间。

### 自适应探针默认策略

- 全局并发：1。
- 全局最小启动间隔：60 秒。
- 单次超时：60 秒；响应首个有效内容后即可结束，仍保留 TTFT。
- 新模型或 0 到 4 条参考样本：轮询补到 5 条，单模型最小间隔 10 分钟。
- 5 到 19 条参考样本：每模型最多每 60 分钟 1 次。
- 达到 20 条后：每模型最多每 6 小时 1 次保鲜。
- 单模型每天最多 20 次；全局每天最多 240 次；预算在 Dashboard 可见、可关闭、可调低。
- 负载不少于 120%、Proxy、目录或采集异常、路由 pending removal 或发布窗口时暂停。
- 连续失败 3 次后按 15 分钟 → 30 分钟 → 1 小时 → 6 小时退避；一次成功后清零。
- 调度公平轮转，优先新模型，再优先样本最少、最后成功最久的模型。

探针 prompt 是固定、无敏感信息、最小输出的健康请求；不携带用户上下文，不触发工具，不用于模型质量评价。

## 控制中心群置顶卡

### 通用插件状态卡能力

Botmux 增加通用的 plugin status-card contribution，而不是写 Trae 专用定时器。插件声明 render endpoint、允许的刷新间隔和是否要求置顶；目标 chat 和 publisher bot 由插件 settings 配置，不写进仓库。

Botmux daemon 使用指定 publisher bot 的飞书凭据：

1. 首次发送一张顶层 Card 2.0；
2. 保存 chat_id、message_id、plugin_id 绑定；
3. 设为群置顶；
4. 平时每分钟 patch 原卡；
5. 模型新增、待下线、异常时立即 patch；
6. 卡片被删除时只补发一次并更新绑定；被取消置顶时按配置重新置顶；
7. 更新失败只影响卡片，不能重启 Proxy 或 9362。

卡片展示总模型数、异常数、上新数、待下线数、前 6 个需要关注模型、自然和探针数据状态、最后更新时间。刷新按钮走现有插件 card-action gateway；Dashboard 按钮使用不含 token 的认证入口，不能把 Dashboard token 写进群卡。

## 内部服务边界

9362 最终只监听 127.0.0.1，保留：

- /health
- /api/snapshot
- /api/refresh
- /internal/usage
- /botmux/card-actions/v1
- status-card render endpoint

删除独立 Web 静态资源和公网或开发机 IP openUrl。Dashboard 和飞书是唯一用户入口。

## 错误处理与降级

- 目录读取失败：不增加缺失计数，不改路由，保留最后成功快照并报警。
- 候选生成失败：不写受管文件，展示 diff 和校验错误。
- 候选验证失败：生产不切换，新模型标 abnormal。
- 生产切换失败：守护恢复旧受管文件、旧配置和旧进程；记录恢复结果。
- usage 落库失败：不阻断 Proxy 请求；Dashboard 显示采集 degraded 和丢弃计数。
- 探针异常：仅暂停对应模型或探针调度，不影响自然流量。
- Dashboard 桥失败：插件页面显示错误和最后成功快照，其他 Dashboard 页面不受影响。
- 飞书卡失败：Dashboard 和 Proxy 保持正常，只记录卡片更新失败。
- SQLite 损坏：隔离损坏文件，保留只读副本，创建新库；不自动删除证据。

## 发布计划

### 阶段 1：只读融合

- 将插件源迁入独立私有 Git 仓库；Botmux 只通过本地 link 安装，不把插件业务代码并入 Botmux 核心，也不再以 temp 目录作为唯一正本。
- 实现 Botmux 同源 service bridge 和完整插件 Dashboard。
- pin trae-model-status 到左侧导航。
- 9362 改为 loopback，只保留内部 API；移除独立 Web。
- 实现目录生命周期、diff、样本来源迁移和 Dashboard 展示。
- routeSyncMode 为 observe，probeMode 为 off，不改生产路由。

### 阶段 2：自动路由与探针

- 实现 AIKit 受管目录模型文件和结构化合并。
- 实现候选 Proxy 验证、独立回滚守护和串行切换。
- 打开 routeSyncMode=apply，验证 TraeX 目录覆盖率。
- 打开 probeMode=adaptive，验证来源隔离、预算和退避。

### 阶段 3：飞书固定入口

- 从现有 Botmux 配置和群身份回读控制中心群 chat id 与 publisher bot；二者只写插件私有 settings，不写进仓库或卡片。
- 发送唯一状态卡，置顶并验证原地自动更新。
- 验证刷新回调、删除恢复、取消置顶恢复和凭据不泄漏。

每个阶段通过后再进入下一阶段；阶段 1 不因阶段 2 失败回退。

## 测试策略

### Botmux

- service bridge allowlist、认证、超时、大小限制、header 剥离和 SSRF 负例；
- pinned plugin 左侧入口和插件页面加载；
- status-card 首发、patch、幂等、删除恢复、置顶和失败隔离；
- 非 Trae 插件与现有机器人行为不变。

### trae-model-status 插件

- 目录新增、连续缺失、读取失败不计缺失、恢复、防抖和 7 天清理；
- 模型状态排序、搜索、别名冲突、unmapped 和 abnormal；
- SQLite migration、自然、探针、validation 分桶和区间阈值；
- 探针公平调度、预算、高负载暂停、退避和重启恢复；
- Dashboard 5 秒刷新、隐藏降频、错误态和最后快照；
- Card 2.0 schema、PC 和移动端预览、刷新后样式一致。

### AIKit 和 Proxy

- 受管文件与手工别名合并、冲突优先级、原子写和 compile 幂等；
- 目录覆盖率、backend variant 选择和缺 metadata 失败；
- probe 来源通过 metadata → Usage Record → sink → SQLite 的端到端证明；
- candidate Proxy、生产切换和故障回滚；
- 自然请求 payload、响应和路由行为不受探针标记影响。

## 验收标准

1. Botmux Dashboard 左侧存在固定 Trae Proxy 入口，无独立 9362 用户网页。
2. 页面可连续 5 秒自动刷新，显示数据新鲜度；刷新失败保留最后快照。
3. 每次成功 TraeX 目录读取后，所有具有可用 backend metadata 的目录模型都存在可调用 Proxy 直接路由。
4. 手工兼容别名逐字保留，自动同步不覆盖或删除。
5. 新模型通过候选验证后自动开放并标记 7 天。
6. 连续 3 次缺失进入待下线；24 小时仍缺失才永久移除；7 天内可查历史。
7. 路由新增、暂停、移除或恢复均有配置 hash、执行结果和回滚点。
8. 自然与探针样本在数据库、API、Dashboard 和飞书卡四处均能区分。
9. 低样本模型能看到探针进度；达到阈值后显示明确置信度的区间。
10. 探针满足单并发、预算、高负载暂停和失败退避，不使用用户数据。
11. 控制中心群只有一张置顶卡，分钟级自动 patch；关键变化立即 patch，不刷出新消息。
12. Dashboard、卡片、探针任一故障都不切断 Proxy；路由切换失败自动回滚。
13. 不在日志、卡片、Dashboard 或 API 中泄漏 quota、API key、Trae token、Dashboard token 或用户 prompt。

## 影响范围

- Botmux：新增通用插件 service bridge 和通用 plugin status-card publisher；启用已有 pinned plugin 入口。
- trae-model-status：重构为内部控制面服务，增加 catalog、route state、probe、Dashboard 和 card publisher endpoint。
- AIKit：新增受管模型文件与结构化合并，保证 compile、start、restart 同源。
- CLIProxyAPI：补齐明确 probe source 的 usage 传递，以及候选路由验证需要的行为 seam。
- 飞书：控制中心群新增一张由现有 Botmux 应用发送的置顶卡，不新增机器人。

实现阶段由 Trae 供给的开发席负责 Proxy 与插件变更；独立复核者验证 Botmux 公共层、路由回滚和真实行为。规格批准本身不授权立即发布，发布仍按上述阶段和守护执行。
