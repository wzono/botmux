# 02: 扩展到全席与未来席位

**What to build:** 让当前全部 team、profile 和群覆盖以及未来新增的 Botmux 机器人从同一公共装配路径继承自适应回复规则，同时保留每个岗位和项目群原有业务约束。

**Blocked by:** 01: 代表席贯通统一规则.

**Status:** resolved

**Resolution:** 全席与未来席位的公共运行时注入已实现并通过独立 R1 审查。审查中的防御性 P2 已补充 Codex App structured zero-injection 实际 wire 负向回归并修复；真实飞书行为仍按批准计划留 Ticket 03。

- [x] 规则由公共 prompt key 和共享组装路径提供，不在席位角色中逐份复制；当前及未来席位走同一运行时规则。
- [x] 新增席位通过现有公共 prompt 组装路径自动继承规则，无需逐 CLI 安装技能。
- [x] 规则装配保持确定性且不增加 team/profile/群角色正文大小。
- [x] team、profile 和群覆盖的角色解析路径未修改，原优先级保持不变。
- [x] 他群定制角色、岗位职责和冻结席位文件未修改。
- [x] Claude、Codex、Traex、Codex App clean input 与 EBSD service-user 代表路径均有自动注入证据；模型、工具、权限和会话后端未修改。
