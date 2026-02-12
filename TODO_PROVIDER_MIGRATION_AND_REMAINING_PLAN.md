# 待办文档：Codex App Server 替换与剩余研发计划

更新时间：2026-02-12

## 1. 目标与范围

本待办覆盖两件事：

1. 将 `control-plane` 的 Codex provider 从 `ai-sdk-provider-codex-cli` 迁移到 `ai-sdk-provider-codex-app-server`。
2. 对照 `设计.md`，整理当前仍未完成的前后端、执行器、Docker 编排、路由/网关相关工作，形成可逐阶段推进清单。

---

## 2. 调研结论（可直接用于实现）

### 2.1 包与仓库

- `ai-sdk-provider-codex-app-server` 最新版：`1.1.7`
- npm 仓库地址：`https://github.com/pablof7z/ai-sdk-provider-codex-app-server`
- 当前项目使用：`ai-sdk-provider-codex-cli@1.0.5`

### 2.2 与当前方案的关键差异

- `codex-cli`：一次性 `codex exec` 进程模型，当前适配器能力是 `humanLoop=false`。
- `codex-app-server`：常驻 `codex app-server`（JSON-RPC）模型，支持：
  - 会话续跑（`resume` + `providerMetadata.codex.sessionId`）
  - 运行中注入输入（`onSessionCreated` 获取 `Session`，调用 `session.injectMessage(...)`）
  - 运行中中断（`session.interrupt()`）

### 2.3 迁移时需要注意的 API 细节

- provider 标识：`codex-app-server`
- 每次调用覆盖参数入口：`providerOptions['codex-app-server']`
- 推荐保留并映射的参数：
  - `cwd`, `approvalMode`, `sandboxMode`, `reasoningEffort`, `mcpServers`, `rmcpClient`, `env`, `configOverrides`
- 新增关键参数：
  - `threadMode: 'persistent' | 'stateless'`
  - `resume`（thread/session 恢复）
  - `onSessionCreated`（用于 human-loop 注入）

### 2.4 落地判断

- 若目标是“运行中 askuser/reply 并继续执行”，`codex-app-server` 方向正确。
- 仅替换 provider 还不够，必须同步补齐平台侧 `human-loop` reply/pending 路由和 run 内 session 映射管理。

---

## 3. Codex Provider 替换待办（Phase P1~P3）

## Phase P1：Provider 接入替换（代码主线）

**目标**：`codex-cli-provider.ts` 切到 `codex-app-server`，并保持现有 `/api/runs/start` 行为兼容。

**改动文件（预期）**：
- `control-plane/package.json`
- `control-plane/src/providers/codex-cli-provider.ts`（建议重命名为 app-server provider）
- `control-plane/src/providers/types.ts`
- `control-plane/src/services/run-orchestrator.ts`
- `control-plane/test/*provider*` 与 `control-plane/test/e2e/human-loop.e2e.test.ts`

**任务清单**：
- [ ] 引入 `ai-sdk-provider-codex-app-server`，移除 `ai-sdk-provider-codex-cli` 依赖。
- [ ] 适配 `createCodexAppServer` 初始化与 `defaultSettings` 映射。
- [ ] 保留兼容字段（`provider: "codex-cli"`）或引入新 kind（`codex-app-server`）并做兼容转换。
- [ ] 将 capabilities 调整为：`resume=true`，`humanLoop=true`（仅 Codex app-server 路径）。
- [ ] 在 run 生命周期中持久化 `sessionId/threadId`（至少先内存态 + 回调透传）。

**验收**：
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `human-loop.e2e` 中“requireHumanLoop=true”路径对 Codex 返回 accepted。

**提交建议**：
- `feat(phase-p1): replace codex-cli provider with codex-app-server`

## Phase P2：Human-loop 路由闭环

**目标**：实现设计里的“待回复查询 + 回复注入 + 继续执行”最小闭环。

**改动文件（预期）**：
- `control-plane/src/routes/*`（新增 human-loop/todo 查询路由）
- `control-plane/src/services/callback-handler.ts`
- `control-plane/src/repositories/*run-callback*`
- `control-plane/test/e2e/human-loop.e2e.test.ts`

**任务清单**：
- [ ] 新增 `GET /human-loop/pending`。
- [ ] 新增 `POST /human-loop/reply`（或 `POST /runs/{runId}/human-loop/{questionId}/reply`）。
- [ ] 将 reply 路由到运行中的 Codex `Session.injectMessage`。
- [ ] 处理幂等（同 `questionId` 重复回复）。
- [ ] 回复后触发 `human_loop.resolved` 并将 run 状态从 `waiting_human` 回到 `running`。

**验收**：
- [ ] 新增 E2E：requested -> pending -> reply -> resolved -> run finish。
- [ ] 重复 reply 返回幂等结果，不破坏 run 状态。

**提交建议**：
- `feat(phase-p2): implement human-loop pending and reply flow`

## Phase P3：真实环境 E2E（Postgres/Docker/RustFS + 真实 executor）

**目标**：不再仅依赖 fixture，接入真实 executor 服务，验证端到端链路。

**改动文件（预期）**：
- `docker-compose.yml`
- `control-plane/test/e2e/real-environment-utils.ts`
- `control-plane/test/e2e/real-infra.e2e.test.ts`
- executor 服务仓库/目录（若在本仓则补 service）

**任务清单**：
- [x] 在 compose 增加可启动的 `control-plane` + `executor` + `postgres` + `rustfs` 组合。
- [x] E2E 改为可命中真实 executor HTTP（保留 fixture 作为 fallback）。
- [ ] 覆盖一次 human-loop 注入场景（pending + reply）。
- [ ] 覆盖 workspace restore/sync + usage 落库 + trace 透传。

**验收**：
- [x] `RUN_REAL_E2E=1 npm run test:e2e:real` 通过（外部 executor 模式）。
- [ ] 关键表存在预期记录：`agent_runs`/`run_events`/`human_loop_requests`/`usage_logs`。

**提交建议**：
- `feat(phase-p3): enable real executor e2e on postgres docker rustfs`

---

## 4. 对照设计.md 的剩余未完成项（跨前后端/执行器/网关）

以下为“已完成阶段之外”仍需推进的项（按优先级）：

## A. 高优先级（应先做）

- [x] Codex App Server 真接入（见 P1）。
- [x] Human-loop 回复闭环（见 P2）。
- [x] Todo 查询接口补齐：
  - `GET /runs/{run_id}/todos`
  - `GET /runs/{run_id}/todos/events`
- [x] 真实 executor 服务接入 real E2E（见 P3）。

## B. 中优先级（平台可用性）

- [x] 前端工作台已重构为 React + TS + Vite，并接入 ChatUI + Todo + Human-loop（tmux 面板废弃）。
- [x] 文件域已接入写能力（上传/重命名/删除/在线编辑）并补齐审计闭环。
- [x] `waiting_human` 超时策略与取消策略已落地（设计 24.3）：新增 `POST /api/reconcile/human-loop-timeout`，并在 `POST /api/runs/:runId/stop` 时批量将 pending 请求置为 `canceled`。
- [x] run-level 对账/修复补齐告警出口与指标看板：新增 `GET /api/reconcile/metrics`（聚合计数 + recent alerts），并覆盖 E2E。

## C. 架构级待完成（企业化）

- [x] 已新增独立 `gateway` 服务（`gateway:3001`）承接 `/api`，`portal` 不再直连 `control-plane`。
- [ ] `executor-manager` 已独立部署并承接 `session-workers` 路由（delegated），但生命周期核心逻辑仍待从 control-plane 完全迁移。
- [x] docker 编排已补齐 `portal + gateway + executor-manager + control-plane + postgres + rustfs + executor + prometheus + alertmanager + grafana + loki + promtail`，并提供基础告警规则与默认看板。
- [ ] 前端流式稳定性（断线重连/游标恢复）与高级工作台交互仍与设计目标存在差距。

---

## 5. 推荐推进顺序（逐阶段 + 每阶段提交）

1. P1 Provider 替换
2. P2 Human-loop 闭环
3. P3 真实环境 E2E
4. Todo 查询路由补齐
5. 前端 React 工作台改造
6. 文件编辑能力与审计补齐
7. 网关/BFF 与部署编排升级

每个阶段结束统一执行：
- `npm run build`
- `npm test`
- 需要真实链路时：`RUN_REAL_E2E=1 npm run test:e2e:real`
- 单阶段提交：`feat(phase-xx): ...`

---

## 6. 调研来源

- GitHub: `pablof7z/ai-sdk-provider-codex-app-server`
  - https://github.com/pablof7z/ai-sdk-provider-codex-app-server
- AI SDK Community Provider 页面（Codex App Server）
  - https://ai-sdk.dev/providers/community-providers/codex-app-server
- npm 包元数据
  - https://www.npmjs.com/package/ai-sdk-provider-codex-app-server
  - https://www.npmjs.com/package/ai-sdk-provider-codex-cli
