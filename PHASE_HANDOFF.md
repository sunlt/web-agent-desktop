## Phase 0: Intake and Goal Definition

### objective
- 基于 `设计.md` 固化可执行研发目标、边界与验收口径。

### inputs
- `设计.md`
- 当前仓库已有内容（`docker-compose.yml`、`executor/Dockerfile`、`scripts/*`、`portal/*`）

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

---

## Phase 11: 可观测性与对账修复（当前迭代切片 K）

### objective
- 建立最小可用的可靠性闭环：结构化日志、stale run 修复、stale sync 补偿。

### inputs
- Phase 9 的 queue 执行循环
- Phase 10 的流式执行链路

### actions
- 新增结构化日志组件 `logger.ts`：
  - JSON 单行输出
  - 支持 `child` 继承上下文
  - 统一字段：`traceId/sessionId/runId/executorId/component`
- `RunQueueManager` 接入结构化日志，记录 claim 执行结果（succeeded/retried/failed/canceled）。
- 扩展仓储能力：
  - `RunQueueRepository.listStaleClaimed()`
  - `SessionWorkerRepository.listStaleSyncCandidates()`
  - InMemory/Postgres 双实现同步补齐
- 新增 `Reconciler` 服务：
  - `reconcileStaleRuns`：修复超时 claimed run，按 attempts 决定 retry/fail
  - `reconcileStaleSync`：扫描过旧 sync 状态并触发补偿同步
- 新增对账路由：
  - `POST /api/reconcile/runs`
  - `POST /api/reconcile/sync`
- 新增测试：
  - `logger.test.ts` 验证结构化字段输出
  - `reconcile.e2e.test.ts` 验证 stale run + stale sync 修复链路

### outputs
- `control-plane/src/observability/logger.ts`
- `control-plane/src/services/reconciler.ts`
- `control-plane/src/routes/reconcile.ts`
- `control-plane/src/services/run-queue-manager.ts`
- `control-plane/src/repositories/run-queue-repository.ts`
- `control-plane/src/repositories/postgres-run-queue-repository.ts`
- `control-plane/src/repositories/in-memory-run-queue-repository.ts`
- `control-plane/src/repositories/session-worker-repository.ts`
- `control-plane/src/repositories/postgres-session-worker-repository.ts`
- `control-plane/src/repositories/in-memory-session-worker-repository.ts`
- `control-plane/test/logger.test.ts`
- `control-plane/test/e2e/reconcile.e2e.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm test`
  - `npm run test:e2e:real`
- results:
  - TypeScript 构建通过
  - Vitest 常规集通过（新增 logger/reconcile 测试）
  - 真实依赖 E2E 通过（无回归）

### gate_result
- **Pass**（可观测性与对账修复基线已完成）

### risks
- 当前日志仍为进程 stdout/stderr，尚未接入统一日志平台与告警规则。
- 对账接口目前为手动触发，尚未接入定时调度器或常驻任务 worker。

### next_phase
- Phase 12：M2 能力补齐（应用商店可见/可用 + 文件只读浏览/下载 + RBAC 基线）。

---

## Phase 12: M2 平台能力补齐（当前迭代切片 L）

### objective
- 落地 M2 最小可运营能力：应用商店可见/可用判定、文件只读浏览下载、文件审计留痕。

### inputs
- 已完成 Phase 8~11 的基础能力（可靠执行、队列、流式、对账）
- `设计.md` 第 14/15/17/18/22 章

### actions
- 新增 RBAC 仓储抽象 `RbacRepository`：
  - 能力：`listStoreAppsForUser`、`canReadPath`、`recordFileAudit`
  - 实现：`InMemoryRbacRepository`、`PostgresRbacRepository`
- 新增数据库迁移 `002_rbac_and_file_acl.sql`：
  - `users/roles/user_role_bindings`
  - `apps/app_visibility_rules/app_members`
  - `file_acl_policies/file_audit_logs`
- 新增文件浏览服务 `LocalReadonlyFileBrowser`：
  - 受限根目录
  - 路径越界防护
  - 目录树与文件下载能力
- 新增路由：
  - `GET /api/apps/store?userId=...`（仅返回可见 app，含 `canUse`）
  - `GET /api/files/tree?userId=...&path=...`
  - `GET /api/files/download?userId=...&path=...`
- 审计：
  - `files tree/download` 均记录 `allowed + reason` 审计
- app/server 组装：
  - 默认 InMemory RBAC + 本地只读文件浏览器
  - Postgres 模式下启用 `PostgresRbacRepository`
  - 文件根目录支持 `FILE_BROWSER_ROOT` 环境变量
- 新增 E2E：
  - `apps-files-rbac.e2e.test.ts` 覆盖可见/可用、文件授权、403 拒绝、审计落点

### outputs
- `control-plane/src/repositories/rbac-repository.ts`
- `control-plane/src/repositories/in-memory-rbac-repository.ts`
- `control-plane/src/repositories/postgres-rbac-repository.ts`
- `control-plane/src/services/file-browser.ts`
- `control-plane/src/routes/apps.ts`
- `control-plane/src/routes/files.ts`
- `control-plane/sql/002_rbac_and_file_acl.sql`
- `control-plane/src/app.ts`
- `control-plane/src/server.ts`
- `control-plane/test/e2e/apps-files-rbac.e2e.test.ts`

### validation
- commands:
  - `npm run build`
  - `npm test`
  - `npm run test:e2e:real`
- results:
  - TypeScript 构建通过
  - Vitest 常规集通过（新增 apps-files-rbac E2E）
  - 真实依赖 E2E 通过（无回归）

### gate_result
- **Pass**（M2 最小平台能力基线已完成）

### risks
- 当前文件能力仍是本地只读浏览器实现，未直接对接 RustFS 预签名下载链路。
- RBAC 规则仍为最小子集，缺少管理端 CRUD 与更细粒度 action/scope 编排。

### next_phase
- 可选扩展：接入 RustFS 文件网关与预签名下载、完善 RBAC 管理 API、补告警与审计检索接口。

---

## Phase 13: 前端重构为 React + TS + Vite

### objective
- 废弃旧 `tmux/html/js` 门户，实现统一 ChatUI 前端并接入 run/todo/human-loop API。

### inputs
- 已完成 `runs` SSE、`todos` 查询、`human-loop` pending/reply 接口。
- 用户要求：todo/human-loop 必须进入 ChatUI，tmux 面板废弃。

### actions
- 重建 `portal` 为 React + TypeScript + Vite 项目。
- 实现 `ChatUI + Todo 分组 + Human-loop 回复面板 + Run timeline`。
- 对接 API：
  - `POST /api/runs/start`（SSE）
  - `POST /api/runs/:runId/stop`
  - `GET /api/runs/:runId/todos`
  - `GET /api/runs/:runId/todos/events`
  - `GET /api/human-loop/pending`
  - `POST /api/human-loop/reply`
- 删除旧静态入口：`tmux.html/script.js/style.css/winbox.bundle.min.js`。

### outputs
- `portal/src/App.tsx`
- `portal/src/main.tsx`
- `portal/src/styles.css`
- `portal/src/vite-env.d.ts`
- `portal/package.json`
- `portal/tsconfig*.json`
- `portal/vite.config.ts`
- `portal/index.html`
- `portal/nginx.conf`

### validation
- commands:
  - `cd portal && npm run build`
- results:
  - Vite 构建通过。

### gate_result
- **Pass**（前端已完成 React 化并接入 todo/human-loop，tmux 面板已废弃）

### risks
- 目前前端仍未接入文件编辑、预览、usage 成本与更细粒度 tool 事件渲染。

### next_phase
- Phase 14：docker 编排补齐 `control-plane + portal` 运行闭环。

---

## Phase 14: Docker 编排补齐 control-plane + portal

### objective
- 形成最小可运行编排：`portal -> control-plane -> postgres`，并保留 `rustfs/agent-runtime` 基础服务。

### inputs
- 已完成前端 React 重构（Phase 13）。
- 现有 compose 缺 `control-plane` 服务、portal 仍以源码卷挂载。

### actions
- 新增 `control-plane` 容器镜像与 `.dockerignore`。
- 修正 `control-plane` 启动脚本：`node dist/src/server.js`。
- 新增 `portal` 多阶段镜像与 `.dockerignore`（构建 Vite 后由 Nginx 托管）。
- 更新 `portal/nginx.conf`：`/api` 代理改为 `control-plane:3000`。
- 更新 `docker-compose.yml`：
  - 增加 `control-plane` 服务（Postgres 模式 + Docker CLI + docker.sock）。
  - `portal` 改为镜像构建模式并依赖 `control-plane`。
  - `pgsql` 挂载 `001_init.sql` + `002_rbac_and_file_acl.sql` 初始化脚本。

### outputs
- `control-plane/Dockerfile`
- `control-plane/.dockerignore`
- `control-plane/package.json`
- `portal/Dockerfile`
- `portal/.dockerignore`
- `portal/nginx.conf`
- `docker-compose.yml`

### validation
- commands:
  - `cd control-plane && npm run build`
  - `cd portal && npm run build`
  - `docker compose config`
- results:
  - `control-plane` TypeScript 构建通过。
  - `portal` Vite 构建通过。
  - compose 配置校验通过。

### gate_result
- **Pass**（最小编排链路已成型）

### risks
- 真实 executor 服务仍未在 compose 中独立落地，`EXECUTOR_BASE_URL` 仍需后续对接。
- 尚未加入独立 gateway/observability 组件。

### next_phase
- Phase 15：接入真实 executor 服务并扩展 real E2E（含 human-loop 注入与 usage/trace 落库断言）。

---

## Phase 15: 真实 executor 服务接入与外部 real E2E

### objective
- 落地独立 executor 服务并接入 docker compose，使 real-infra E2E 支持外部 executor 模式。

### inputs
- 已完成 Phase 14 最小编排（portal + control-plane + pgsql）。
- `control-plane` 已支持 `EXECUTOR_BASE_URL` / token / retry / timeout。

### actions
- 新增 `executor` 独立服务（TypeScript + Express）：
  - `POST /workspace/restore`
  - `POST /workspace/link-agent-data`
  - `POST /workspace/validate`
  - `POST /workspace/sync`
  - `GET /health`
  - `GET /events`
- executor 支持可选 Bearer 鉴权（`EXECUTOR_AUTH_TOKEN`）。
- executor 通过 S3 API 将 workspace 同步到 RustFS（`@aws-sdk/client-s3`）。
- 更新 compose：
  - 新增 `executor` 服务。
  - `control-plane` 默认接入 `EXECUTOR_BASE_URL=http://executor:8090`。
  - 新增 `EXECUTOR_AUTH_TOKEN` 等重试/超时配置。
  - `rustfs` 补凭据环境变量。
  - RustFS 宿主机端口调整为 `19000/19001`（避开已有 9000 端口占用）。
- 更新 `control-plane` real E2E：
  - 外部 executor 模式下新增 `/health` 预检查。
- 新增 `control-plane` 脚本：
  - `npm run test:e2e:external-executor`

### outputs
- `executor/package.json`
- `executor/package-lock.json`
- `executor/tsconfig.json`
- `executor/.gitignore`
- `executor/.dockerignore`
- `executor/Dockerfile`
- `executor/src/server.ts`
- `docker-compose.yml`
- `control-plane/package.json`
- `control-plane/test/e2e/real-infra.e2e.test.ts`

### validation
- commands:
  - `cd executor && npm run build`
  - `cd control-plane && npm run build`
  - `docker compose config`
  - `docker compose build executor control-plane`
  - `docker compose up -d rustfs executor pgsql control-plane`
  - `cd control-plane && npm run test:e2e:external-executor`
  - `cd control-plane && npm test`
- results:
  - executor/control-plane 构建通过。
  - compose 配置/镜像构建通过。
  - 外部 executor real E2E 通过（3/3）。
  - control-plane 常规测试通过。

### gate_result
- **Pass**（真实 executor 服务与外部 E2E 链路可用）

### risks
- executor 仍是最小实现，尚未覆盖复杂权限、增量策略与大文件同步优化。
- human-loop 注入场景在 external executor 模式下尚未补到 real E2E。

### next_phase
- Phase 16：补充前端 E2E（ChatUI + todo + human-loop）与 executor/网关观测增强。

---

## Phase 16: 前端 useChat 接入与剩余任务重排

### objective
- 将前端聊天状态管理迁移到 `ai-sdk/react`，并保留当前 run/todo/human-loop 真实链路能力。

### inputs
- 已完成的 React ChatUI（手写 SSE 解析版）。
- 已完成的后端 `POST /api/runs/start` SSE 事件流。

### actions
- 在 `portal` 引入 `@ai-sdk/react` 与 `ai` 依赖。
- 将 `portal/src/App.tsx` 重构为：
  - 使用 `useChat` 管理消息发送与消息列表。
  - 通过自定义 `ChatTransport` 兼容现有 `/api/runs/start` SSE 协议。
  - 将 `run.status/message.delta/todo.update/run.warning/run.closed` 映射到 UIMessage chunk + 侧边面板状态。
- 同步更新剩余研发清单：
  - `REMAINING_DEVELOPMENT_TASKS.md` 新增 Phase 16（进行中）与 Phase 17（待启动），明确前端缺口（历史会话、文件域、商店接入、前端 E2E）。

### outputs
- `portal/src/App.tsx`
- `portal/package.json`
- `portal/package-lock.json`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `cd portal && npm run build`
- results:
  - TypeScript + Vite 构建通过。

### gate_result
- **Pass**（前端已接入 `ai-sdk/react` 且现有主链路无回退）

### risks
- 当前仍缺少前端自动化 E2E，回归主要依赖手工联调与构建门禁。
- 历史会话、文件编辑/预览、应用商店接入仍未落地。

### next_phase
- Phase 17：补齐前端 E2E 与工作台剩余能力（history/files/store/stream-reconnect）。

---

## Phase 17: 前端 E2E 基线（Playwright）

### objective
- 为 ChatUI 主链路建立自动化前端回归能力，优先覆盖 run 流式消息、todo 面板、human-loop 回复闭环。

### inputs
- 已完成 Phase 16（`useChat` + 自定义 transport）。
- 现状缺少前端自动化测试框架与用例。

### actions
- 在 `portal` 引入 Playwright 测试依赖与配置：
  - 新增 `playwright.config.ts`
  - 新增 npm scripts：`test` / `test:e2e` / `test:e2e:ui`
- 新增 E2E 用例 `portal/e2e/tests/chat-workbench.spec.ts`：
  - 用 route mock 模拟 `/api/runs/start` SSE 事件流。
  - 覆盖“发送消息 -> assistant 流式回包 -> todo.update 面板渲染”路径。
  - 覆盖“human-loop pending -> reply -> 列表清空 + timeline 更新”路径。
- 安装 Chromium 浏览器运行时并执行测试验证。
- 更新剩余研发文档状态：
  - Phase 16 标记完成。
  - Phase 17 标记进行中并挂载 E2E 基线任务。

### outputs
- `portal/playwright.config.ts`
- `portal/e2e/tests/chat-workbench.spec.ts`
- `portal/package.json`
- `portal/package-lock.json`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `cd portal && npm run build`
  - `cd portal && npm run test:e2e`
  - `cd portal && npm run test`
- results:
  - Vite 构建通过。
  - Playwright E2E 通过（2/2）。
  - 统一测试脚本通过（2/2）。

### gate_result
- **Pass**（前端 E2E 基线已落地，关键交互可自动回归）

### risks
- 当前 E2E 使用 API route mock，尚未覆盖真实后端联调与断线重连行为。
- 文件域/历史会话/应用商店能力仍无前端自动化覆盖。

### next_phase
- Phase 17 后续子阶段：接入历史会话与文件域，扩展真实联调型前端 E2E。

---

## Phase 17: 历史会话（chatId -> session_id）前后端接入

### objective
- 落地历史会话最小闭环：后端提供会话列表/创建/加载/保存接口，前端支持会话切换与消息持久化恢复。

### inputs
- `设计.md` 23.4/23.5 关于历史会话 API 与 `chatId -> session_id` 映射要求。
- 已完成 Phase 16 `useChat` 前端主链路与 Phase 17 E2E 基线。

### actions
- 后端新增 chat history 仓储与路由：
  - 新增仓储接口与实现：InMemory + Postgres。
  - 新增路由：`GET/POST /api/chat-opencode-history`、`GET/PUT /api/chat-opencode-history/:chatId`。
  - 新增 Postgres 迁移 `003_chat_history.sql`，并更新 compose 初始化挂载。
- 前端 `portal` 接入历史会话：
  - 启动时加载历史列表，无历史则自动创建首会话。
  - 支持会话切换、手动新建会话。
  - `useChat` 完成后自动调用历史保存接口持久化消息。
  - 聊天区新增 history pane（左侧列表）。
- 测试补齐：
  - control-plane 新增 `chat-history.e2e.test.ts`。
  - portal Playwright mock 扩展 chat history 接口，保持 2 条用例通过。

### outputs
- `control-plane/src/repositories/chat-history-repository.ts`
- `control-plane/src/repositories/in-memory-chat-history-repository.ts`
- `control-plane/src/repositories/postgres-chat-history-repository.ts`
- `control-plane/src/routes/chat-history.ts`
- `control-plane/src/app.ts`
- `control-plane/src/server.ts`
- `control-plane/sql/003_chat_history.sql`
- `control-plane/test/e2e/chat-history.e2e.test.ts`
- `docker-compose.yml`
- `portal/src/App.tsx`
- `portal/src/styles.css`
- `portal/e2e/tests/chat-workbench.spec.ts`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `cd control-plane && npm run build`
  - `cd control-plane && npm test`
  - `cd portal && npm run build`
  - `cd portal && npm run test`
- results:
  - control-plane 构建通过，测试通过（`chat-history.e2e` 新增并通过）。
  - portal 构建通过，Playwright 2/2 通过。

### gate_result
- **Pass**（历史会话前后端闭环可用）

### risks
- 当前会话消息保存采用整段覆盖写入，尚未做增量写入优化。
- 历史会话未接入权限模型（当前默认同租户可见），后续需补账号维度隔离。

### next_phase
- Phase 17 后续子阶段：文件域编辑/预览能力 + 应用商店接入 + 历史会话权限隔离。

---

## Phase 17: 文件域可写能力与 ChatUI Files/Preview 接入

### objective
- 落地文件域写能力（读写/上传/重命名/删除/建目录）与审计闭环，并在前端工作台接入 Files/Preview 面板。

### inputs
- 已有文件只读接口：`GET /api/files/tree`、`GET /api/files/download`。
- `REMAINING_DEVELOPMENT_TASKS.md` Phase 17 中“文件域/文件预览”任务待完成。

### actions
- 后端 `control-plane`：
  - RBAC 仓储补齐 `canWritePath`（InMemory + Postgres）。
  - `FileBrowser` 扩展可写能力与分页读取：
    - `readFile` / `writeFile` / `rename` / `deletePath` / `mkdir`。
  - 文件路由扩展：
    - `GET /api/files/file`
    - `PUT /api/files/file`
    - `POST /api/files/upload`
    - `POST /api/files/rename`
    - `DELETE /api/files/file`
    - `POST /api/files/mkdir`
  - `download` 增加 `inline=1` 支持，供图片/PDF 内嵌预览。
  - 新增 E2E 覆盖写链路与审计动作断言。
- 前端 `portal`：
  - 在 ChatUI 右侧新增 `Files` 面板（目录刷新/上级、上传、新建文件、新建目录、重命名、删除、下载）。
  - 新增 `Preview` 面板：
    - 文本读取与在线编辑保存。
    - 图片/PDF 内嵌预览。
    - 大文件分段读取（`继续加载`）。
  - Playwright 增加 Files 用例，验证“读取 + 保存”闭环。
- 文档状态同步：
  - 更新 `REMAINING_DEVELOPMENT_TASKS.md` 与 `TODO_PROVIDER_MIGRATION_AND_REMAINING_PLAN.md` 的文件域完成状态。

### outputs
- `control-plane/src/repositories/rbac-repository.ts`
- `control-plane/src/repositories/in-memory-rbac-repository.ts`
- `control-plane/src/repositories/postgres-rbac-repository.ts`
- `control-plane/src/services/file-browser.ts`
- `control-plane/src/routes/files.ts`
- `control-plane/test/e2e/apps-files-rbac.e2e.test.ts`
- `portal/src/App.tsx`
- `portal/src/styles.css`
- `portal/e2e/tests/chat-workbench.spec.ts`
- `REMAINING_DEVELOPMENT_TASKS.md`
- `TODO_PROVIDER_MIGRATION_AND_REMAINING_PLAN.md`

### validation
- commands:
  - `cd control-plane && npm run build`
  - `cd control-plane && npm test`
  - `cd portal && npm run build`
  - `cd portal && npm test`
- results:
  - control-plane 构建通过，测试通过（含 `apps-files-rbac.e2e` 写链路新增用例）。
  - portal 构建通过，Playwright 3/3 通过（新增 Files 面板用例）。

### gate_result
- **Pass**（文件域写能力与前端 Files/Preview 基线可用）

### risks
- 文本预览尚未加入语法高亮；当前为纯文本编辑模式。
- 图片/PDF 预览依赖 `download?inline=1`，后续可补独立 preview API 与缓存策略。

### next_phase
- Phase 17 后续子阶段：应用商店接入 + human-loop UX 增强 + 流式断线重连/游标恢复。

---

## Phase 17: 应用商店接入与会话入口联动

### objective
- 在 ChatUI 内接入应用商店可见/可用列表，并将选中应用联动到 run 启动参数，形成“选应用 -> 发起会话/运行”闭环。

### inputs
- 后端已具备 `GET /api/apps/store?userId=...` 能力。
- Phase 17 已完成历史会话与文件域接入，当前缺“应用商店接入”子任务。

### actions
- 前端 `portal`：
  - 新增“应用商店”面板，按 `userId` 拉取可见应用并展示 `可用/仅可见` 状态。
  - 支持切换当前应用（仅可用应用可选）。
  - 新建会话时将应用名称写入默认会话标题（`[AppName] 新会话`）。
  - 发送消息时将应用选择联动到 `/api/runs/start`：
    - `executionProfile = appId`
    - `providerOptions.storeAppId = appId`
  - Run 状态面板补充当前应用显示。
- 测试补齐：
  - Playwright 新增用例验证“选择应用 -> 发送消息 -> runs/start 负载携带 appId”。
  - mock API 新增 `/api/apps/store` 处理与 `runs/start` 请求体捕获。
- 样式补齐：
  - 新增应用商店面板样式（列表、激活态、状态信息）。

### outputs
- `portal/src/App.tsx`
- `portal/src/styles.css`
- `portal/e2e/tests/chat-workbench.spec.ts`
- `REMAINING_DEVELOPMENT_TASKS.md`
- `TODO_PROVIDER_MIGRATION_AND_REMAINING_PLAN.md`

### validation
- commands:
  - `cd portal && npm run build`
  - `cd portal && npm test`
  - `cd control-plane && npm test`
- results:
  - portal 构建通过。
  - Playwright 4/4 通过（新增应用商店联动用例）。
  - control-plane 测试通过（无回归）。

### gate_result
- **Pass**（应用商店展示与 run 入口参数联动已落地）

### risks
- 当前 run 侧仅透传 `executionProfile/providerOptions`，尚未在后端执行链路做强约束校验。
- 应用选择按前端会话维度管理，尚未入库到 chat session 元数据。

### next_phase
- Phase 17 后续子阶段：human-loop 体验增强（超时/幂等反馈/resolved 历史）+ 流式断线重连与 cursor 恢复。

---

## Phase 17: Human-loop UX（超时提示 + 幂等反馈）

### objective
- 改善 Human-loop 交互体验：提供超时可视提示，但不自动完成；对重复回复返回提供幂等反馈提示。

### inputs
- 现有前端仅展示 pending 问题与回复输入，不含超时提示与 duplicate 反馈。
- 用户明确要求“可以有超时提示，但不要自动完成”。

### actions
- 前端 `portal`：
  - 增加 Human-loop 超时状态计算：
    - 默认超时阈值 `5min`（支持 metadata `deadlineAt` / `timeoutMs` 覆盖）。
    - 卡片展示 `剩余 xx` 或 `已超时 xx（仅提示，不自动完成）`。
    - 超时卡片仅变更样式，不触发自动 resolved/移除。
  - 增加回复反馈：
    - `POST /api/human-loop/reply` 返回 `duplicate=true` 时，展示“已处理（幂等返回）”提示，并保留卡片。
    - 常规成功回复展示“回复已提交，等待 run 继续”反馈。
  - 增加周期 tick（15s）刷新超时提示文本。
  - 增加对应样式（超时态边框/提示文案）。
- 测试补齐：
  - Playwright 断言 pending 卡片出现“仅提示，不自动完成”文案。
  - 新增 duplicate 反馈用例，验证卡片不自动消失且提示文案正确。
  - mock API 扩展 duplicate 回包能力。

### outputs
- `portal/src/App.tsx`
- `portal/src/styles.css`
- `portal/e2e/tests/chat-workbench.spec.ts`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `cd portal && npm run build`
  - `cd portal && npm test`
  - `cd control-plane && npm test`
- results:
  - portal 构建通过。
  - Playwright 5/5 通过（新增 2 条 human-loop UX 相关断言）。
  - control-plane 测试通过（无回归）。

### gate_result
- **Pass**（human-loop 超时提示与幂等反馈已可用，且不自动完成）

### risks
- 当前仍缺 `resolved` 历史回看面板/接口，完整 human-loop 体验尚未闭环。

### next_phase
- Phase 17 后续子阶段：human-loop resolved 历史回看 + 流式断线重连与 cursor 恢复。

---

## Phase 17: 执行器工作目录文件管理 + TTY 接入

### objective
- 在 ChatUI 内补齐设计文档要求的执行器侧辅助面板：
  - 执行器工作目录文件管理（`/workspace`）
  - TTY 命令执行面板
- 保留并并行支持全局文件管理面板（RBAC `files` 路由）。

### inputs
- 既有全局文件接口：`/api/files/*`。
- gateway 已支持 `/api/session-workers/* -> executor-manager` 分流。
- executor-manager 已持有 `sessionId -> containerId` 生命周期映射。

### actions
- 后端（executor）新增工作目录与命令执行接口：
  - `GET /workspace/tree`
  - `GET /workspace/file`
  - `PUT /workspace/file`
  - `POST /workspace/upload`
  - `POST /workspace/rename`
  - `DELETE /workspace/file`
  - `POST /workspace/mkdir`
  - `GET /workspace/download`
  - `POST /tty/exec`
- 后端（executor-manager）新增按 `sessionId` 的代理路由：
  - `GET /api/session-workers/:sessionId/workspace/tree`
  - `GET /api/session-workers/:sessionId/workspace/file`
  - `PUT /api/session-workers/:sessionId/workspace/file`
  - `POST /api/session-workers/:sessionId/workspace/upload`
  - `POST /api/session-workers/:sessionId/workspace/rename`
  - `DELETE /api/session-workers/:sessionId/workspace/file`
  - `POST /api/session-workers/:sessionId/workspace/mkdir`
  - `GET /api/session-workers/:sessionId/workspace/download`
  - `POST /api/session-workers/:sessionId/tty/exec`
- 前端（portal）重构文件面板：
  - 将原单一 Files/Preview 面板改为两个独立面板：
    - 执行器工作目录文件面板（基于 `sessionId`）
    - 全局文件管理面板（基于 `userId`）
  - 两个面板均支持：树浏览、预览、编辑、上传、重命名、删除、下载。
- 前端新增 TTY 面板：支持 `command/cwd/timeout` 输入、执行历史、`stdout/stderr/exitCode` 展示。
- Playwright 用例补齐：新增“执行器工作目录 + TTY”联动用例，并同步更新 Files/Preview 断言定位。

### outputs
- `executor/src/server.ts`
- `executor/src/workspace-files.ts`
- `executor/src/workspace-terminal.ts`
- `executor-manager/src/ports/executor-client.ts`
- `executor-manager/src/adapters/executor-http-client.ts`
- `executor-manager/src/adapters/noop-executor-client.ts`
- `executor-manager/src/services/lifecycle-manager.ts`
- `executor-manager/src/routes/session-workers.ts`
- `portal/src/App.tsx`
- `portal/src/styles.css`
- `portal/src/workbench/use-file-workspace.ts`
- `portal/src/workbench/use-session-terminal.ts`
- `portal/src/workbench/file-workspace-panel.tsx`
- `portal/src/workbench/session-terminal-panel.tsx`
- `portal/e2e/tests/chat-workbench.spec.ts`
- `portal/e2e/tests/support/mock-portal-api.ts`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `cd executor && npm run lint && npm run typecheck`
  - `cd executor-manager && npm run lint && npm run typecheck`
  - `cd portal && npm run lint && npm run typecheck`
  - `cd portal && npm run test:e2e`
- results:
  - executor lint/typecheck 通过。
  - executor-manager lint/typecheck 通过。
  - portal lint/typecheck 通过。
  - Playwright 8/8 通过（新增执行器工作目录 + TTY 用例）。

### gate_result
- **Pass**（ChatUI 已具备 Todo + TTY + 双文件管理 + 预览编辑上传能力，tmux 面板路径持续废弃）

### risks
- 当前 TTY 为命令执行型（request/response），非全交互流式终端；如需真正 pty 流式交互需额外引入 websocket/pty 网关。
- 执行器工作目录面板依赖有效 `sessionId` 与已存在 worker；未激活会话时会提示而不自动创建。

### next_phase
- Phase 18/19：真实环境（compose + external executor）完整对话闭环 E2E 稳定化与回归收敛。

---

## Phase 19: 真实环境完整对话闭环 E2E 稳定化

### objective
- 在真实部署拓扑（`gateway + executor-manager + control-plane + executor + postgres + rustfs`）下，固化可重复执行的“完整对话闭环”验证能力，并消除对外部模型依赖。

### inputs
- `REMAINING_DEVELOPMENT_TASKS.md` 中 Phase 17 的最后一条未完成验证项（真实环境完整对话闭环）。
- 当前 compose 链路已可运行，但 `runs/start` 依赖外部 provider 运行时，稳定性受环境影响。
- 现有真实链路脚本仅覆盖 session-worker 生命周期与 callback/sync，不覆盖 chat + run 对话路径。

### actions
- control-plane 增加可切换 provider 模式：
  - 新增 `control-plane/src/providers/scripted-provider.ts`，实现 `opencode/claude-code/codex-cli` 的 deterministic scripted adapter。
  - `control-plane/src/app.ts` 增加 `CONTROL_PLANE_PROVIDER_MODE=scripted` 分支，默认保持真实 provider。
- compose 环境透传：
  - `docker-compose.yml` 为 `control-plane` 增加 `CONTROL_PLANE_PROVIDER_MODE=${CONTROL_PLANE_PROVIDER_MODE:-real}`。
- 新增真实环境闭环脚本：
  - `scripts/e2e-full-conversation-real-env.sh`，覆盖：
    - 会话激活
    - chat 历史创建/更新
    - `/api/runs/start` SSE 事件流校验（started/message/todo/finished/closed）
    - run bind
    - callback：`todo.update`、`human_loop.requested`、`human_loop.resolved`、`message.stop`、`run.finished`
    - 查询：`todos`、`todo events`、`human-loop resolved`
    - DB 校验：`agent_runs`、`run_events`、`human_loop_requests`、`usage_logs`
    - cleanup idle/stopped + worker 删除态确认
  - 针对真实链路 `cleanup` 超时 `502` 增加请求重试策略。
  - 增加 migration 补偿步骤（001/002/003），解决历史 volume 下 `chat_sessions` 缺失问题。

### outputs
- `control-plane/src/providers/scripted-provider.ts`
- `control-plane/src/app.ts`
- `docker-compose.yml`
- `scripts/e2e-full-conversation-real-env.sh`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `cd control-plane && npm run lint && npm run typecheck`
  - `bash scripts/e2e-full-conversation-real-env.sh`
  - `bash scripts/pre-commit-check.sh`
- results:
  - control-plane lint/typecheck 通过。
  - phase19 real-env 脚本完整通过（含 DB 记录断言、cleanup 删除断言）。
  - 全仓 pre-commit 检查通过。

### gate_result
- **Pass**（真实环境完整对话闭环验证已可稳定复现，Phase 17 最后一条真实联调验证项可视为完成）

### risks
- `scripted` provider 模式主要用于基础设施联调稳定性；真实模型质量与工具链行为仍需在真实 provider 模式下另行压测。
- cleanup 路由在极端慢 I/O 下仍可能出现网关超时，当前通过脚本重试缓解，后续可考虑服务端异步化或更细粒度超时配置。

### next_phase
- Phase 20：补齐 `portal` 真实后端 Playwright smoke（非 mock API）与真实 provider 模式压测基线。

---

## Phase 20: Portal 真实后端 Smoke E2E

### objective
- 为 ChatUI 增加“非 mock API”的真实后端 smoke 验证，确保 `portal -> gateway -> control-plane/executor-manager` 链路在真实 compose 环境稳定可用。

### inputs
- 已有 `portal` Playwright 用例主要基于 route mock，无法覆盖真实后端联通性。
- 已有 phase19 脚本验证后端链路，但不覆盖浏览器端真实交互。
- 用户要求继续推进剩余 task，优先补齐真实联调口径。

### actions
- Playwright real 模式支持：
  - 修改 `portal/playwright.config.ts`：
    - `PORTAL_E2E_REAL=1` 时禁用 `webServer`，改为连接 `PORTAL_E2E_BASE_URL`（默认 `http://127.0.0.1`）。
- 新增真实后端 smoke 用例：
  - `portal/e2e/tests/chat-workbench.real-smoke.spec.ts`
  - 用例路径：打开门户 -> 发送真实消息 -> 验证 assistant 收到 scripted 回包 -> 验证 run 状态 `succeeded`。
  - 设定 `REAL_PORTAL_E2E=1` 才启用，避免影响常规 mock E2E。
- 新增一键脚本：
  - `scripts/e2e-portal-real-smoke.sh`
  - 能力：
    - 启动 compose 全链路（含 `portal`）并设置 `CONTROL_PLANE_PROVIDER_MODE=scripted`
    - 自动执行 DB migration 补偿（001/002/003）
    - 执行 `portal` real-backend Playwright smoke
- 稳定性修正：
  - 移除 real smoke 中依赖 `todo-grid` 持久内容的断言（run 收尾后会被轮询覆盖，导致非稳定失败）。

### outputs
- `portal/playwright.config.ts`
- `portal/e2e/tests/chat-workbench.real-smoke.spec.ts`
- `scripts/e2e-portal-real-smoke.sh`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `cd portal && npm run lint && npm run typecheck`
  - `bash scripts/e2e-portal-real-smoke.sh`
  - `bash scripts/pre-commit-check.sh`
- results:
  - portal lint/typecheck 通过。
  - real-backend Playwright smoke 通过（1/1）。
  - 全仓 pre-commit 检查通过。

### gate_result
- **Pass**（portal 已具备真实后端 smoke 验证闭环）

### risks
- 该 smoke 使用 `scripted provider` 聚焦链路连通性，不覆盖真实 LLM 行为波动与长会话压力。
- 目前 real smoke 仅覆盖单浏览器、单场景；后续可扩展多场景与并发压测。

### next_phase
- Phase 21：真实 provider 模式下的 portal 对话压测（限流/超时/重连）与 flaky 收敛。

---

## Phase 21: 真实 Provider 压测基线与 Flaky 收敛（基线）

### objective
- 在真实 provider 模式（`CONTROL_PLANE_PROVIDER_MODE=real`）下建立稳定性压测基线，量化 run 成功率与失败画像，支撑后续收敛。

### inputs
- Phase 20 已具备 portal 真实后端 smoke，但仍使用 scripted provider 聚焦链路联通。
- 用户已同意继续下一阶段，需要进入真实 provider 稳定性验证。

### actions
- 新增压测脚本 `scripts/e2e-portal-real-provider-stress.sh`：
  - 启动 compose 服务并固定为 `CONTROL_PLANE_PROVIDER_MODE=real`
  - 自动补齐 DB migration（001/002/003）
  - 按轮次执行 `POST /api/runs/start` SSE 请求（可配置 provider/model/timeout/iterations）
  - 解析流式事件并分类结果：`succeeded / failed / blocked / canceled / transport_error / incomplete`
  - 生成 JSON 报告到 `observability/reports/phase21-provider-stress-*.json`
  - 支持严格门禁：
    - `STRESS_STRICT=1`
    - `STRESS_SUCCESS_RATE_THRESHOLD=<0~1>`
  - 默认 non-strict 观测模式（用于先采样再收敛）。
- 更新 `.gitignore`，忽略 `observability/reports/` 运行产物，避免污染版本库。
- 实跑基线脚本，获取真实 provider 在当前环境下的首批统计结果。

### outputs
- `.gitignore`
- `scripts/e2e-portal-real-provider-stress.sh`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `bash scripts/e2e-portal-real-provider-stress.sh`
  - `bash scripts/pre-commit-check.sh`
- results:
  - 压测脚本执行完成并输出报告（当前环境 `codex-cli` 5/5 failed，error detail 一致，successRate=0）。
  - 全仓 pre-commit 检查通过。

### gate_result
- **Pass**（真实 provider 稳定性基线已形成，具备可重复测量能力）

### risks
- 当前真实 provider 运行全部失败，说明仍存在环境依赖缺失/配置不完整（凭据、provider runtime 或运行参数）。
- 基线阶段仅建立“测量能力与事实数据”，尚未实施针对性修复。

### next_phase
- Phase 21 后续子阶段：按失败画像逐项收敛（provider 凭据探测、启动前校验、失败可视化与自动降级策略）。

---

## Phase 21: 真实 Provider 压测收敛（预检/分类/建议）

### objective
- 在基线压测之上补齐“可诊断”能力：启动前预检、失败分类、修复建议与可选降级探针，降低 flaky 排障成本。

### inputs
- Phase 21 基线压测脚本已可输出成功率与基础失败统计。
- 当前环境真实压测结果稳定为 `provider_no_output`，需要更细粒度定位信息。

### actions
- 增强 `scripts/e2e-portal-real-provider-stress.sh`：
  - 新增 provider runtime 预检：
    - executor 容器存在性
    - provider 二进制可用性与版本
    - auth footprint 检查（按 provider 差异化路径）
  - 新增 preflight 试运行（在正式压测前先跑 1 次）。
  - 统一 SSE 解析并输出失败分类与建议：
    - 新增 `failureClass` 与 `suggestion`
    - 覆盖 `transport_error/auth_missing/model_invalid/provider_no_output/...` 等类别
  - 新增可选自动降级探针：
    - `STRESS_AUTO_FALLBACK_SCRIPTED=1` 时，预检失败触发 scripted probe（随后恢复 real 模式）
  - 新增 Markdown 报告输出（与 JSON 同名）。
- 执行脚本与全仓门禁，确认增强无回归。

### outputs
- `scripts/e2e-portal-real-provider-stress.sh`
- `REMAINING_DEVELOPMENT_TASKS.md`

### validation
- commands:
  - `bash scripts/e2e-portal-real-provider-stress.sh`
  - `bash scripts/pre-commit-check.sh`
- results:
  - 脚本完成 precheck + preflight + 5 轮压测并生成 JSON/Markdown 报告。
  - 当前样本为 `provider_no_output`（5/5 failed），报告已包含失败分类计数与建议。
  - 全仓 pre-commit 检查通过。

### gate_result
- **Pass**（Phase 21 子阶段“可诊断能力”已落地）

### risks
- 当前失败聚类仍集中在 `provider_no_output`，需要结合 executor/provider 内部日志进一步定位根因（凭据、模型可用性、网络策略或 provider 运行时行为）。
- 自动降级探针默认关闭，CI 若需启用需明确策略以避免掩盖真实 provider 回归。

### next_phase
- Phase 21 后续子阶段：增加跨服务日志抓取与失败样本自动归档（runId 级别），并在 CI 引入可选 strict 门禁阈值。
