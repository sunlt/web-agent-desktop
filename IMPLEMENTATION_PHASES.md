# Agent Worker 项目实施阶段（基于 设计.md）

**Workflow Mode**: `incremental`（当前仓库已有容器与门户基础能力，新增控制面与执行编排能力）  
**编排技能链路**: `$rd-workflow-orchestrator -> $project-planning -> $nodejs-backend-typescript -> $test-driven-development`  
**目标版本**: M1（最小可用链路）

## Phase 1: 控制面基础骨架
**Type**: Infrastructure + API  
**Estimated**: 3 小时  
**Files**: `control-plane/package.json`, `control-plane/tsconfig.json`, `control-plane/src/server.ts`, `control-plane/src/routes/health.ts`, `control-plane/src/routes/session-workers.ts`

**Tasks**:
- [x] 初始化 TypeScript + Express 工程
- [x] 提供健康检查与基础路由
- [x] 定义 session worker 领域类型与状态枚举
- [x] 建立内存版仓储接口（后续替换 Postgres）

**Verification Criteria**:
- [x] `npm run build` 通过
- [x] `GET /health` 返回 200
- [x] session worker 基本路由可启动

**Exit Criteria**:
- 控制面可运行并提供后续阶段需要的可扩展接口

## Phase 2: Session 生命周期核心能力
**Type**: Backend  
**Estimated**: 4 小时  
**Files**: `control-plane/src/domain/session-worker.ts`, `control-plane/src/services/lifecycle-manager.ts`, `control-plane/src/services/workspace-path.ts`, `control-plane/src/services/sync-policy.ts`, `control-plane/test/lifecycle-manager.test.ts`

**Tasks**:
- [x] 实现 `workspace_s3_prefix` 统一计算
- [x] 实现用户消息触发的 `create/start/restore/run` 前置决策
- [x] 实现 idle stop 与 long-stopped remove 的门闩逻辑
- [x] 实现同步状态写回（`last_sync_status/last_sync_error`）

**Verification Criteria**:
- [x] 单测覆盖 stop/remove 前必须先 sync
- [x] 单测覆盖 sync 失败时禁止 remove
- [x] 单测覆盖容器不存在时标记 deleted

**Exit Criteria**:
- 生命周期逻辑满足 `设计.md` 的核心状态机与数据一致性约束

## Phase 3: Runtime Manifest 恢复编排
**Type**: Architecture + Backend  
**Estimated**: 4 小时  
**Files**: `control-plane/src/domain/runtime-manifest.ts`, `control-plane/src/services/restore-plan.ts`, `control-plane/src/routes/runs.ts`, `control-plane/test/restore-plan.test.ts`, `control-plane/test/e2e/restore-plan.e2e.test.ts`

**Tasks**:
- [x] 定义 Runtime Manifest 与 Restore Plan 严格类型
- [x] 按 L0~L4 生成恢复计划
- [x] 实现冲突策略与 protected paths 校验
- [x] 暴露 run 前恢复接口契约

**Verification Criteria**:
- [x] restore plan 单测覆盖默认 `keep_session`
- [x] required paths 校验失败会阻断 run
- [x] 接口返回结构可被 executor 消费

**Exit Criteria**:
- manager 可按 manifest 下发 restore plan，并在 run 前完成校验

## Phase 4: Provider 统一抽象（P0 三 Provider）
**Type**: Backend + Integration  
**Estimated**: 6 小时  
**Files**: `control-plane/src/providers/adapter.ts`, `control-plane/src/providers/opencode.ts`, `control-plane/src/providers/claude-code.ts`, `control-plane/src/providers/codex-cli.ts`, `control-plane/src/services/run-orchestrator.ts`

**Tasks**:
- [x] 建立 `ProviderKind -> Adapter` 注册表
- [x] 统一 `run/stream/stop` 最小能力
- [x] capability-gated 处理 `resume/human-loop/todo`
- [x] 统一事件映射 `message/tool/todo/workspace/run`

**Verification Criteria**:
- [x] 三 provider 均可完成最小 run/stream/stop
- [x] 无 human-loop 能力时按降级策略返回可操作提示
- [x] 单 provider 故障不影响其他 provider 调度

**Exit Criteria**:
- 完成 M1 必须的三 provider 接入与能力门控

## Phase 5: 持久化与回调一致性
**Type**: Database + Backend  
**Estimated**: 5 小时  
**Files**: `control-plane/sql/001_init.sql`, `control-plane/src/repo/postgres-session-worker-repo.ts`, `control-plane/src/repo/postgres-run-repo.ts`, `control-plane/src/services/callback-handler.ts`

**Tasks**:
- [x] 建立 `session_workers/run_queue/human_loop/todo` 基础表
- [x] 回调事件按 `event_id` 幂等写入
- [x] `message.stop` 触发增量同步
- [x] usage 最终结算在 run 完成事件执行

**Verification Criteria**:
- [x] 数据库迁移可执行
- [x] 回调重复投递不会重复落库
- [x] `waiting_human`/`todo.update` 状态可正确回放

**Exit Criteria**:
- 后端事实源完整可用，满足状态回放与审计

## Phase 6: M1 端到端联调
**Type**: E2E  
**Estimated**: 4 小时  
**Files**: `control-plane/test/e2e/run-lifecycle.e2e.test.ts`, `control-plane/test/e2e/human-loop.e2e.test.ts`, `control-plane/test/e2e/todo-stream.e2e.test.ts`

**Tasks**:
- [x] 覆盖 run 正常路径、stop、remove 与恢复
- [x] 覆盖 human-loop 支持/不支持的两类路径
- [x] 覆盖 todo 实时更新和历史回放

**Verification Criteria**:
- [x] 关键路径 E2E 全绿
- [x] 无阻塞级 flaky

**Exit Criteria**:
- M1 达到可用发布门槛

## Phase 7: 真实依赖联调（Post-M1）
**Type**: Integration + E2E  
**Estimated**: 6 小时  
**Files**: `control-plane/src/adapters/docker-cli-client.ts`, `control-plane/src/adapters/executor-http-client.ts`, `control-plane/src/services/lifecycle-manager.ts`, `control-plane/src/server.ts`, `control-plane/test/e2e/real-infra.e2e.test.ts`

**Tasks**:
- [x] 接入真实 Docker 适配器（create/start/stop/remove/exists）
- [x] 接入真实 executor HTTP 客户端（restore/link/validate/sync）
- [x] 在 session activate 流程中串联 restore -> link -> validate
- [x] 默认 server 支持 ENV 切换 Postgres + Docker + Executor 真实模式
- [x] 增加 Postgres + Docker + RustFS 真实环境 E2E（可开关运行）
- [x] 跨进程 trace 头透传（trace_id/session_id/executor_id/run_id/operation/ts）
- [x] 增加 executor 失败注入 E2E，校验 sync 失败时 worker 不被误删且状态可观测

**Verification Criteria**:
- [x] 常规测试默认可通过（真实环境用例默认跳过）
- [x] `RUN_REAL_E2E=1` 时真实环境链路 E2E 通过
- [x] 真实链路中可观察到 workspace 文件同步到 RustFS
- [x] 回调触发的 `workspace.sync.message.stop` 链路可观测到 `run_id`
- [x] 注入 `/workspace/sync` 500 后 `cleanup/idle` 返回 `failed=1` 且 worker 保持 `running`

**Exit Criteria**:
- control-plane 具备切换到真实基础设施联调的能力

## Phase 8: 正式 Executor 对接硬化
**Type**: Integration + Reliability  
**Estimated**: 4 小时  
**Files**: `control-plane/src/adapters/executor-http-client.ts`, `control-plane/src/server.ts`, `control-plane/test/executor-http-client.test.ts`, `control-plane/test/e2e/real-infra.e2e.test.ts`

**Tasks**:
- [x] Executor HTTP 客户端支持可配置重试（仅 5xx/网络超时）
- [x] 细化错误分类（http/timeout/network）并统一错误结构
- [x] server 支持 ENV 配置重试参数（次数/退避/状态码）
- [x] 增加单测覆盖鉴权 header 与重试策略
- [x] 增加真实 E2E 覆盖“瞬时 500 后重试成功”

**Verification Criteria**:
- [x] `npm run build` 通过
- [x] `npm test` 通过（新增 `executor-http-client` 单测）
- [x] `RUN_REAL_E2E=1` 时真实环境 E2E 通过（含 retry 成功用例）

**Exit Criteria**:
- control-plane 具备接入正式 executor 所需的基础可靠性（鉴权、超时、重试、可观测错误）

## Phase 9: Run Queue 执行循环（claim/lock/retry）
**Type**: Backend + Database  
**Estimated**: 5 小时  
**Files**: `control-plane/src/repositories/run-queue-repository.ts`, `control-plane/src/repositories/postgres-run-queue-repository.ts`, `control-plane/src/services/run-queue-manager.ts`, `control-plane/src/routes/run-queue.ts`, `control-plane/test/e2e/run-queue.e2e.test.ts`

**Tasks**:
- [x] 落地 `run_queue` 仓储抽象（内存 + Postgres）
- [x] 实现 claim 逻辑（`FOR UPDATE SKIP LOCKED` + 锁过期重领）
- [x] 实现 attempt/retry/final-fail 状态流转
- [x] 新增队列 API（enqueue/drain/query）
- [x] 增加单测与 E2E 覆盖 retry 与锁恢复

**Verification Criteria**:
- [x] `npm run build` 通过
- [x] `npm test` 通过（新增 run-queue 单测与 E2E）
- [x] `RUN_REAL_E2E=1` 时真实依赖用例仍通过（无回归）

**Exit Criteria**:
- run 调度具备队列驱动基础能力，支持幂等入队、claim、重试与失败封顶
