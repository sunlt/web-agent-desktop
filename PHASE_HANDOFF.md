## Phase 0: Intake and Goal Definition

### objective
- 基于 `设计.md` 固化可执行研发目标、边界与验收口径。

### inputs
- `设计.md`
- 当前仓库已有内容（`docker-compose.yml`、`dockerfile`、`scripts/*`、`portal/*`）

### actions
- 完整审阅设计文档（含 session lifecycle、manifest、provider 能力约束）。
- 对照仓库现状确认 workflow mode 为 `incremental`。
- 识别首批可落地切片：控制面骨架 + 生命周期核心逻辑。

### outputs
- `IMPLEMENTATION_PHASES.md`（阶段拆分与验收标准）
- 当前阶段风险清单与下一阶段实施建议

### gate_result
- **Pass**（范围和验收标准可测试）

### risks
- 设计覆盖面极大，若缺少明确优先级容易导致 M1 膨胀。
- 三 provider 的 human-loop 能力不对齐，需要 capability gate 严格约束。

### next_phase
- Phase 1: Planning（已进入执行）

---

## Phase 1: Planning

### objective
- 将 M1 范围拆成可在单次迭代中执行的薄切片，并明确每阶段 gate。

### inputs
- Phase 0 输出
- `设计.md` 的 M1/M2/M3 里程碑建议

### actions
- 生成阶段计划：基础骨架、生命周期、manifest、provider、持久化、E2E。
- 为每个阶段定义：文件边界、验证标准、退出条件。
- 选择当前迭代实施切片：Phase 1 + Phase 2 的基础部分。

### outputs
- `IMPLEMENTATION_PHASES.md`
- 当前迭代计划（本次提交将实现 control-plane 初始化 + 生命周期核心与测试）

### gate_result
- **Pass**（任务分解具备可执行性和可验证性）

### risks
- 缺少现成后端工程，需要先完成基础脚手架。
- Postgres/RustFS/Docker 真集成依赖后续环境联调。

### next_phase
- Phase 4 Backend（先落地最小可运行代码，再扩展到 DB 与 provider 集成）

---

## Phase 4: Backend Implementation（当前迭代切片 A）

### objective
- 落地 session worker 生命周期最小可运行核心：`activate / idle-stop / long-stop-remove`。

### inputs
- `设计.md` 第 4/5/25 章生命周期与同步门闩要求
- Phase 1 计划输出

### actions
- 初始化 `control-plane` TypeScript 后端工程。
- 实现 `SessionWorker` 领域模型、内存仓储、`LifecycleManager`。
- 实现 `/api/session-workers/*` 路由与健康检查。
- 增加单测覆盖 sync 成功/失败与 remove 门闩。
- 修复一次测试暴露的状态覆盖缺陷（sync 成功状态被 stop/remove 覆盖）。

### outputs
- `control-plane/*` 代码与测试
- 通过 `npm run build` 与 `npm run test`

### gate_result
- **Pass**（当前切片的功能与测试门禁通过）

### risks
- 当前使用内存仓储与 noop 适配器，尚未接入 Postgres/Docker/RustFS 实现。
- 仅覆盖生命周期基础能力，provider 编排与回调持久化尚未落地。

### next_phase
- Phase 5: 持久化与回调一致性（优先接入 Postgres schema + Repository）

---

## Phase 5: 持久化与回调一致性（当前迭代切片 B）

### objective
- 落地数据库事实源基线与回调一致性机制（event 幂等、message.stop 同步、run 完成结算）。

### inputs
- `设计.md` 第 18/24/25 章
- 已完成的 Phase 4 生命周期服务

### actions
- 新增 `control-plane/sql/001_init.sql`，建立 `session_workers/run_queue/agent_runs/run_events/usage_logs/human_loop/todo` 表。
- 实现 Postgres 仓储：`PostgresSessionWorkerRepository`、`PostgresRunCallbackRepository`。
- 实现 `CallbackHandler`：支持 `message.stop`、`todo.update`、`human_loop.requested/resolved`、`run.finished`。
- 将 `LifecycleManager` 暴露 `syncSessionWorkspace()`，用于回调路径触发增量同步。
- 新增回调路由：`/api/runs/:runId/callbacks` 与本地绑定入口 `/api/runs/:runId/bind`。
- 执行迁移到本地 `pgsql` 并验证建表结果。

### outputs
- 持久化脚本：`control-plane/sql/001_init.sql`
- 回调一致性服务与仓储实现：`control-plane/src/services/callback-handler.ts` 等
- 新增单测：`control-plane/test/callback-handler.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm run test`
  - `PGPASSWORD=app123456 psql -h 127.0.0.1 -p 5432 -U app -d app -v ON_ERROR_STOP=1 -f control-plane/sql/001_init.sql`
  - `PGPASSWORD=app123456 psql -h 127.0.0.1 -p 5432 -U app -d app -c "\\dt"`
- results:
  - TypeScript 构建通过
  - Vitest: 13 tests passed
  - 迁移成功并创建 9 张核心表

### gate_result
- **Pass**（Phase 5 计划项与验证项完成）

### risks
- 当前 server 仍以 in-memory 实现默认启动，生产接入需切换到 Postgres/Docker/RustFS 真实适配器。
- `run_queue` claim + lock + retry 尚未在 manager 层实现执行循环。

### next_phase
- Phase 4（剩余）+ Phase 6：接入三 provider 抽象层并做端到端联调

---

## Phase 4: Provider 统一抽象（当前迭代切片 C）

### objective
- 完成三 provider 的统一 adapter 抽象与运行编排，落实 capability gate 与故障隔离。

### inputs
- `设计.md` 第 20 章 provider 能力矩阵与抽象接口
- 已完成的 Phase 5 回调基础

### actions
- 新增 provider 类型与能力模型：`ProviderKind/ProviderRunInput/ProviderRunHandle`。
- 实现三 provider adapter（mock 形态）与 `ProviderRegistry`。
- 实现 `RunOrchestrator`：`startRun/streamRun/stopRun/getRunSnapshot`。
- 实现 capability 降级：
  - `humanLoop` 不支持时直接 block 并返回可操作原因
  - `resume` 不支持时降级为新会话并返回 warning
- 接入路由：`POST /api/runs/start`、`POST /api/runs/{runId}/stop`、`GET /api/runs/{runId}`。
- 新增测试覆盖 registry、capability gate、provider 故障隔离。

### outputs
- `control-plane/src/providers/*`
- `control-plane/src/services/run-orchestrator.ts`
- `control-plane/src/routes/runs.ts`
- `control-plane/test/provider-registry.test.ts`
- `control-plane/test/run-orchestrator.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm run test`
- results:
  - TypeScript 构建通过
  - Vitest: 18 tests passed

### gate_result
- **Pass**（Phase 4 计划项与验证项通过）

### risks
- 当前 provider 为 mock adapter，下一步需替换为真实 `ai-sdk-provider-*` 实现与流式传输。
- `/api/runs/start` 目前为“同步收集事件后返回”，后续需升级为真正流式协议。

### next_phase
- Phase 6: E2E 联调（run lifecycle/human-loop/todo 回放）

---

## Phase 4: Provider 真实接入（当前迭代切片 D）

### objective
- 将三 provider 从 mock adapter 替换为真实 `ai-sdk-provider-*` 接入，并统一映射为内部 stream 事件。

### inputs
- 已完成的 Provider 抽象层（切片 C）
- `ai-sdk-provider-opencode-sdk` / `ai-sdk-provider-claude-code` / `ai-sdk-provider-codex-cli`

### actions
- 新增通用运行时桥接：`streamText(fullStream) -> message.delta/todo.update/run.finished`。
- 实现 `providerOptions` 到官方 provider settings 的参数映射（`resume/tools/cwd/profile/sandbox/approval` 等）。
- 新增 `createControlPlaneApp()`，解耦 server 启动与测试注入。
- 修复 `zod@4` 下 `z.record` 的签名变更。
- 删除未使用的 `BaseMockProvider`。

### outputs
- `control-plane/src/providers/runtime-utils.ts`
- `control-plane/src/providers/opencode-provider.ts`
- `control-plane/src/providers/claude-code-provider.ts`
- `control-plane/src/providers/codex-cli-provider.ts`
- `control-plane/src/app.ts`
- `control-plane/src/server.ts`

### validation
- commands:
  - `npm run build`
  - `npm run test`
- results:
  - TypeScript 构建通过
  - Vitest 全绿

### gate_result
- **Pass**（三 provider 已完成真实接入）

### risks
- `codex-cli` provider 当前未暴露明确 resume 会话参数，能力门控维持 `resume: false`。
- `/api/runs/start` 仍为聚合返回模式，尚未切换真正 SSE/WS 实时推送。

### next_phase
- Phase 6: E2E 联调补齐（lifecycle/human-loop/todo）

---

## Phase 6: M1 端到端联调（当前迭代切片 E）

### objective
- 补齐 M1 关键路径 E2E：run lifecycle、human-loop 能力分流、todo 流与回放。

### inputs
- 已完成真实 provider 接入与 callback 路由

### actions
- 新增 `run-lifecycle` E2E：覆盖 `activate -> idle stop -> restart -> remove stopped`。
- 新增 `human-loop` E2E：覆盖支持/不支持两类 provider 的路由返回与运行行为。
- 新增 `todo-stream` E2E：覆盖 `todo.update` 最新状态与时间线回放。
- 保留并复用现有 HTTP E2E 测试（runs/callbacks）作为补充。

### outputs
- `control-plane/test/e2e/run-lifecycle.e2e.test.ts`
- `control-plane/test/e2e/human-loop.e2e.test.ts`
- `control-plane/test/e2e/todo-stream.e2e.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm run test`
- results:
  - TypeScript 构建通过
  - Vitest: 24 tests passed

### gate_result
- **Pass**（Phase 6 关键路径已覆盖并稳定通过）

### risks
- 当前 E2E 仍以内存仓储 + fake 依赖为主，尚未覆盖 Postgres/Docker 真实联调。

### next_phase
- Phase 3: Runtime Manifest 恢复编排（L0~L4 计划、冲突策略、required path 校验）

---

## Phase 3: Runtime Manifest 恢复编排（当前迭代切片 F）

### objective
- 完成 run 前 restore 编排契约：严格 manifest 类型、L0~L4 计划、required/protected 校验与 API 暴露。

### inputs
- `设计.md` 第 15.3、16.3、25.2、26 章
- 已完成的 runs 路由与 app 组装

### actions
- 扩展 `RuntimeManifest`/`RestorePlan` 严格类型：`seedFiles`、`mountPoints`、`cleanupRules`、`requiredPaths`。
- 在 `buildRestorePlan` 中实现：
  - `conflictPolicy` 默认 `keep_session`
  - L0~L4 entries（新增 `runtime_fixups`）
  - `runtimeVersion` 一致性校验
  - `required/protected/mount/seed/cleanup` 路径安全校验（必须绝对路径且在 `/workspace` 下）
- 新增 `validateRequiredPaths`，用于 run 前阻断缺失必需路径。
- 在 `/api/runs/restore-plan` 暴露 restore plan 契约：
  - 校验通过返回 `200 { ok: true, plan }`
  - required path 缺失返回 `422 { ok: false, reason: required_paths_missing }`

### outputs
- `control-plane/src/domain/runtime-manifest.ts`
- `control-plane/src/services/restore-plan.ts`
- `control-plane/src/routes/runs.ts`
- `control-plane/test/restore-plan.test.ts`
- `control-plane/test/e2e/restore-plan.e2e.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm run test`
- results:
  - TypeScript 构建通过
  - Vitest: 29 tests passed

### gate_result
- **Pass**（Phase 3 计划项和验收项完成）

### risks
- restore 校验目前基于入参 `existingPaths`，尚未与真实 executor `/workspace/validate` 回传对接。

### next_phase
- Post-M1 联调：接入真实 Postgres/Docker/RustFS 适配器并补真实环境 E2E

---

## Phase 7: 真实依赖联调（当前迭代切片 G）

### objective
- 把 control-plane 从“内存 + noop 适配器”推进到可切换真实基础设施联调：Postgres、Docker、executor HTTP、RustFS。

### inputs
- 已完成的 Phase 3/4/5/6 代码
- 本地已运行基础设施：`pgsql` 容器与 Docker daemon

### actions
- 新增 `DockerCliClient`，使用 `docker` CLI 实现 `create/start/stop/remove/exists`。
- 新增 `ExecutorHttpClient`，对接 `POST /workspace/restore|link-agent-data|validate|sync`。
- 在 `LifecycleManager.activateSession()` 中引入可选 workspace 准备链路：
  - `restore -> link-agent-data -> validate`（由 `runtimeVersion + manifest` 触发）。
- `run-callback` 仓储抽象升级为通用接口，Postgres 仓储新增 `bindRun()`。
- `server.ts` 支持 ENV 切换真实模式：
  - `CONTROL_PLANE_STORAGE=postgres`
  - `CONTROL_PLANE_DOCKER=cli`
  - `EXECUTOR_BASE_URL=...`
- 新增真实环境 E2E：
  - 启动 RustFS 容器
  - 启动 executor fixture（真实 HTTP）
  - 使用 Postgres 仓储 + DockerCli + ExecutorHttp 跑生命周期与回调
  - 校验 RustFS 对象写入成功
- 新增跨进程观测透传：
  - `WorkspaceSyncRequest` 与 `ExecutorClient` 增加 `trace` 元数据
  - `ExecutorHttpClient` 把 trace 映射为 `x-trace-*` 请求头
  - `LifecycleManager` 在 `restore/link/validate/sync` 统一生成并透传 trace
  - `message.stop` 回调触发的 sync 链路补传 `runId`
- 新增失败注入 E2E：
  - executor fixture 支持按接口路径注入失败（次数/状态码/响应体）
  - 注入 `/workspace/sync` 500，验证 `cleanup/idle` 失败计数与 worker 状态保持

### outputs
- `control-plane/src/adapters/docker-cli-client.ts`
- `control-plane/src/adapters/executor-http-client.ts`
- `control-plane/src/ports/executor-client.ts`
- `control-plane/src/repositories/run-callback-repository.ts`
- `control-plane/src/repositories/postgres-run-callback-repository.ts`
- `control-plane/src/services/lifecycle-manager.ts`
- `control-plane/src/server.ts`
- `control-plane/test/e2e/real-environment-utils.ts`
- `control-plane/test/e2e/real-infra.e2e.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm test`
  - `npm run test:e2e:real`
- results:
  - TypeScript 构建通过
  - Vitest 常规集通过（真实 E2E 默认 skip）
  - 真实依赖 E2E 通过（Postgres + Docker + RustFS + Executor，含失败注入用例）
  - 可在 executor fixture 事件中观测 `trace_id` / `executor_id` / `run_id` / `operation`

### gate_result
- **Pass**（真实依赖联调能力已可用）

### risks
- 当前 executor 仍是 fixture 形态；接入正式 executor 服务时需严格对齐 HTTP 协议与鉴权策略。
- Docker CLI 方式依赖宿主机 docker 可执行文件与权限；生产建议补充健康检查与重试退避。

### next_phase
- 对接正式 executor 服务并替换 fixture（鉴权、超时、重试策略对齐），补跨服务日志聚合与告警门限。

---

## Phase 8: 正式 Executor 对接硬化（当前迭代切片 H）

### objective
- 把 executor 接口从“可联调”提升到“可生产对接”：增加重试策略、错误分类、ENV 策略化配置与真实重试用例。

### inputs
- 已完成的 Phase 7 真实依赖联调能力
- `设计.md` 中关于 stop/remove 前同步重试与告警可观测要求（第 5/10/24 章）

### actions
- `ExecutorHttpClient` 增加重试策略：
  - 仅对 5xx（默认 `500/502/503/504`）与网络/超时错误重试
  - 4xx 直接失败，不进入重试
  - 线性退避（`retryDelayMs * attempt`）
- 新增 `ExecutorRequestError`，统一错误分类：
  - `http` / `timeout` / `network`
  - 带 `path/attempt/maxAttempts/status` 等上下文字段
- `server.ts` 增加重试策略 ENV 配置：
  - `EXECUTOR_MAX_RETRIES`
  - `EXECUTOR_RETRY_DELAY_MS`
  - `EXECUTOR_RETRY_STATUS_CODES`
- 新增单测 `executor-http-client.test.ts`：
  - 鉴权头与 trace 头透传
  - 500 瞬时失败自动重试成功
  - 400 快速失败且不重试
- 扩展真实 E2E：
  - 保持“失败注入后失败”的用例（`maxRetries=0`）
  - 新增“失败注入一次后重试成功”用例（`maxRetries=1`）

### outputs
- `control-plane/src/adapters/executor-http-client.ts`
- `control-plane/src/server.ts`
- `control-plane/test/executor-http-client.test.ts`
- `control-plane/test/e2e/real-infra.e2e.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm test`
  - `npm run test:e2e:real`
- results:
  - TypeScript 构建通过
  - Vitest 常规集通过（新增 executor client 单测）
  - 真实依赖 E2E 通过（3 条用例，含 retry 成功路径）

### gate_result
- **Pass**（正式 executor 对接的可靠性硬化已完成）

### risks
- 当前仍使用 fixture 模拟 executor，尚未验证正式服务在鉴权失败、限流、慢响应场景下的真实行为。
- 重试策略为客户端本地策略，尚未接入全局熔断/速率限制。

### next_phase
- Phase 9：落地 `run_queue` claim/lock/retry 执行循环（含崩溃恢复与幂等消费）。

---

## Phase 9: Run Queue 执行循环（当前迭代切片 I）

### objective
- 落地 queue 驱动执行基线：run 入队、claim、执行、重试、失败封顶与状态查询。

### inputs
- 已完成的运行编排 `RunOrchestrator`
- 已存在的 `run_queue` 表结构（`sql/001_init.sql`）

### actions
- 新增队列仓储接口与类型：
  - `RunQueueRepository` / `RunQueueItem` / `RunQueuePayload`
- 实现 `InMemoryRunQueueRepository`：
  - 支持幂等入队、claim、重试回队、失败封顶
  - 支持 `claimed + lock_expires_at` 过期后重新 claim（崩溃恢复）
- 实现 `PostgresRunQueueRepository`：
  - claim 使用 `FOR UPDATE SKIP LOCKED`
  - 支持 `queued/claimed` 可领取条件与锁续占
  - 支持 `attempts/max_attempts` 下的 retry/fail 切换
- 新增 `RunQueueManager`：
  - `enqueueRun()` 入队
  - `drainOnce()` 批量 claim 并串行执行
  - 处理 `succeeded/retried/failed/canceled` 统计
- 新增队列 API：
  - `POST /api/runs/queue/enqueue`
  - `POST /api/runs/queue/drain`
  - `GET /api/runs/queue/:runId`
- `app.ts/server.ts` 完成组装：
  - 默认内存队列仓储
  - Postgres 模式下自动切换 `PostgresRunQueueRepository`
  - 支持队列参数 ENV：`RUN_QUEUE_OWNER/LOCK_MS/RETRY_DELAY_MS`

### outputs
- `control-plane/src/repositories/run-queue-repository.ts`
- `control-plane/src/repositories/in-memory-run-queue-repository.ts`
- `control-plane/src/repositories/postgres-run-queue-repository.ts`
- `control-plane/src/services/run-queue-manager.ts`
- `control-plane/src/routes/run-queue.ts`
- `control-plane/src/app.ts`
- `control-plane/src/server.ts`
- `control-plane/test/run-queue-manager.test.ts`
- `control-plane/test/e2e/run-queue.e2e.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm test`
  - `npm run test:e2e:real`
- results:
  - TypeScript 构建通过
  - Vitest 常规集通过（新增 queue 单测与 E2E）
  - 真实依赖 E2E 通过（现有联调链路无回归）

### gate_result
- **Pass**（run_queue 执行循环基础能力已可用）

### risks
- 当前 `drainOnce` 为手动触发模式，尚未接入常驻 worker 循环与并发 worker 竞争测试。
- queue 执行结果当前仅更新 `run_queue`，尚未把 `agent_runs/run_events` 做深度联动聚合。

### next_phase
- Phase 10：升级 `/api/runs/start` 为 SSE 实时流（含断线重连游标与历史回放）。

---

## Phase 10: 流式执行协议升级（当前迭代切片 J）

### objective
- 把 run 执行从“聚合后返回”升级为“实时流返回”，并提供断线重连回放能力。

### inputs
- 已完成的 `RunOrchestrator`
- 已完成的 Phase 9 queue 能力（run 生命周期可重复触发）

### actions
- 新增 `StreamBus`（内存事件总线）：
  - 为每个 run 维护递增 `seq`
  - 保存历史事件并支持 `afterSeq` 回放
  - 支持 stream close 通知
- 升级 `runs` 路由：
  - `POST /api/runs/start` 在 `Accept: text/event-stream` 下返回 SSE
  - 非 SSE 保持原 JSON 聚合模式（向后兼容）
  - 新增 `GET /api/runs/:runId/stream` 用于断线重连
  - 支持 `cursor` 查询参数或 `last-event-id` header 继续消费
- 新增 `runs-stream` E2E：
  - 验证 SSE 事件可实时消费
  - 验证 cursor 回放只返回游标后的事件

### outputs
- `control-plane/src/services/stream-bus.ts`
- `control-plane/src/routes/runs.ts`
- `control-plane/test/e2e/runs-stream.e2e.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm test`
  - `npm run test:e2e:real`
- results:
  - TypeScript 构建通过
  - Vitest 常规集通过（新增 runs-stream E2E）
  - 真实依赖 E2E 通过（既有联调能力无回归）

### gate_result
- **Pass**（SSE 实时流与断线回放能力已可用）

### risks
- 当前 `StreamBus` 为进程内内存实现，横向扩容后需要外部事件总线（Redis/Kafka/NATS 等）保证多实例回放一致性。
- 尚未实现长连接限流与背压策略，极高并发下需补网关层保护。

### next_phase
- Phase 11：可观测性与对账修复（结构化日志 + stale run 自动修复）。
