# 剩余研发推进计划（Phase 8+）

**基线状态**: Phase 1~7 已完成（控制面、生命周期、provider、持久化、真实依赖联调、trace/failure 注入 E2E）。
**推进方式**: 严格按阶段串行推进；每阶段结束必须完成验证并提交 git。

## 提交与门禁规则（强制）

每个阶段必须按以下顺序结束：
1. 代码实现与文档同步完成。
2. 执行阶段验证命令（至少 `npm run build`、`npm test`，涉及真实环境时加 `npm run test:e2e:real`）。
3. 仅提交该阶段相关改动（`git add <files>`）。
4. 提交信息格式：`feat(phase-X): <阶段目标>` 或 `fix(phase-X): <问题>`。
5. 在 `PHASE_HANDOFF.md` 追加该阶段 `actions/outputs/validation/gate_result/risks/next_phase`。

---

## Phase 8: 正式 Executor 对接硬化
**Type**: Integration + Reliability
**Estimated**: 4~6 小时
**目标**: 从“fixture 可用”提升到“正式服务可接入”，补鉴权、重试、超时与错误分类。

**范围文件**:
- `control-plane/src/adapters/executor-http-client.ts`
- `control-plane/src/server.ts`
- `control-plane/src/app.ts`
- `control-plane/test/e2e/real-environment-utils.ts`
- `control-plane/test/e2e/real-infra.e2e.test.ts`

**Tasks**:
- [x] 支持 executor token 鉴权（Bearer）与可配置超时。
- [x] 增加可配置重试（仅 5xx/网络超时可重试，4xx 快速失败）。
- [x] 明确错误分类（timeout/network/http_status）并落入错误信息。
- [x] 增加“瞬时失败后成功”的真实 E2E（验证重试生效）。

**Verification Criteria**:
- [x] `npm run build` 通过。
- [x] `npm test` 通过。
- [x] `npm run test:e2e:real` 通过，包含 retry 成功用例。

**Exit Criteria**:
- control-plane 能在不改代码的情况下通过 ENV 对接正式 executor（鉴权+重试+超时策略可控）。

---

## Phase 9: Run Queue 执行循环（claim/lock/retry）
**Type**: Backend + Database
**Estimated**: 6~8 小时
**目标**: 落地 `run_queue` 消费循环，支持并发 claim、锁续期、失败重试与幂等恢复。

**范围文件**:
- `control-plane/src/services/run-queue-manager.ts`（新增）
- `control-plane/src/repositories/postgres-run-queue-repository.ts`（新增）
- `control-plane/src/server.ts`
- `control-plane/sql/00x_run_queue_*.sql`（新增）
- `control-plane/test/e2e/run-queue.e2e.test.ts`（新增）

**Tasks**:
- [x] 实现 `FOR UPDATE SKIP LOCKED` claim。
- [x] 支持 attempt 计数、retry_at、最大重试次数。
- [x] 支持 manager 崩溃恢复（过期锁回收）。
- [x] run 去重与幂等（相同 run_id 不重复执行）。

**Verification Criteria**:
- [x] 并发 claim 下无重复消费。
- [x] 注入失败后按策略重试并可最终成功/失败封顶。
- [x] e2e 验证 manager 重启后可接续处理。

**Exit Criteria**:
- run 调度从手动触发升级为队列驱动，满足设计文档的 queue 能力基线。

---

## Phase 10: 流式执行协议升级（SSE/WS）
**Type**: API + E2E
**Estimated**: 6~8 小时
**目标**: `/api/runs/start` 从聚合返回改为实时流，前后端可消费统一事件。

**范围文件**:
- `control-plane/src/routes/runs.ts`
- `control-plane/src/services/run-orchestrator.ts`
- `control-plane/src/services/stream-bus.ts`（新增）
- `control-plane/test/e2e/runs-stream.e2e.test.ts`（新增）

**Tasks**:
- [x] 提供 SSE（优先）或 WS 事件流接口。
- [x] 输出标准化事件：`message/tool/todo/human_loop/run`。
- [x] 支持断线重连后的事件回放游标。

**Verification Criteria**:
- [x] 流式事件按顺序到达，结束态一致。
- [x] `message.stop`、`todo.update`、`run.finished` 在流上可观察。

**Exit Criteria**:
- 前端可实时消费 run 过程，无需轮询聚合结果。

---

## Phase 11: 可观测性与对账修复
**Type**: Reliability + Ops
**Estimated**: 4~6 小时
**目标**: 建立最小可用的跨服务观测与自动修复能力。

**范围文件**:
- `control-plane/src/observability/logger.ts`（新增）
- `control-plane/src/services/reconciler.ts`（新增）
- `control-plane/src/server.ts`
- `control-plane/test/e2e/reconcile.e2e.test.ts`（新增）

**Tasks**:
- [x] 结构化日志统一字段（trace_id/session_id/run_id/executor_id）。
- [x] 超时 run 对账任务（query executor 状态，失败兜底落库）。
- [x] 过旧 sync 状态补偿任务（增量 sync）。

**Verification Criteria**:
- [x] 注入 manager 中断后可自动修复 run 终态。
- [x] 异常路径可通过 trace 字段串联日志。

**Exit Criteria**:
- 关键异常具备自动修复或明确告警出口。

---

## Phase 12: M2 平台能力补齐（商店/权限/文件只读）
**Type**: Product + API
**Estimated**: 8~12 小时
**目标**: 对齐设计文档 M2：应用商店可见/可用、project/user 配置、全局文件浏览只读下载。

**范围文件**:
- `control-plane/src/routes/apps.ts`（新增）
- `control-plane/src/routes/files.ts`（新增）
- `control-plane/src/repositories/rbac-*.ts`（新增）
- `control-plane/sql/00x_rbac_*.sql`（新增）
- `control-plane/test/e2e/apps-files-rbac.e2e.test.ts`（新增）

**Tasks**:
- [x] 最小 RBAC（users/departments/roles/bindings）。
- [x] 应用商店可见/可用策略接口。
- [x] 文件树浏览与下载（只读）。

**Verification Criteria**:
- [x] 未授权用户不可见/不可用目标 app。
- [x] 文件读取行为全链路审计可追溯。

**Exit Criteria**:
- 达成 M2 基础可运营门槛。

---

## Phase 13: 前端重构为 React + TS + Vite（已完成）
**Type**: Frontend + Integration
**Estimated**: 6~10 小时
**目标**: 废弃旧 `tmux/html` 门户，统一为 ChatUI，并接入 run/todo/human-loop 接口。

**范围文件**:
- `portal/src/App.tsx`
- `portal/src/main.tsx`
- `portal/src/styles.css`
- `portal/package.json`
- `portal/vite.config.ts`
- `portal/nginx.conf`

**Tasks**:
- [x] 重建 `portal` 为 React + TypeScript + Vite 项目结构。
- [x] 接入 `POST /api/runs/start` SSE 流式消费。
- [x] 接入 `GET /runs/:runId/todos`、`GET /runs/:runId/todos/events`。
- [x] 接入 `GET /human-loop/pending`、`POST /human-loop/reply`。
- [x] 删除旧 `tmux.html/script.js/style.css/winbox` 静态页面实现。

**Verification Criteria**:
- [x] `portal` 构建通过。

**Exit Criteria**:
- ChatUI 具备 run/todo/human-loop 一体化基础能力，tmux 面板路径废弃。

---

## Phase 14: Docker 编排补齐 control-plane + portal（当前完成）
**Type**: Infra + Compose
**Estimated**: 2~4 小时
**目标**: 形成可启动的最小平台编排，打通 `portal -> control-plane -> postgres` 基础链路。

**范围文件**:
- `docker-compose.yml`
- `control-plane/Dockerfile`
- `control-plane/.dockerignore`
- `portal/Dockerfile`
- `portal/.dockerignore`
- `portal/nginx.conf`
- `control-plane/package.json`

**Tasks**:
- [x] 新增 `control-plane` 容器镜像，支持生产模式启动。
- [x] 新增 `portal` 容器镜像，构建 Vite 产物并由 Nginx 托管。
- [x] `portal` 的 `/api` 代理指向 `control-plane:3000`。
- [x] `pgsql` 初始化挂载 `control-plane/sql/001_init.sql` 与 `002_rbac_and_file_acl.sql`。
- [x] `docker-compose` 新增/更新服务依赖关系（`portal` 依赖 `control-plane`）。

**Verification Criteria**:
- [x] `docker compose config` 通过。
- [x] `npm run build`（`control-plane`、`portal`）通过。

**Exit Criteria**:
- 编排层具备最小可运行拓扑，可在本地一键拉起前后端+DB 基础服务。

---

## Phase 15: 真实 executor 服务接入与外部 E2E（当前完成）
**Type**: Infra + Real E2E
**Estimated**: 4~8 小时
**目标**: 引入独立 executor 服务并接入 compose，使 real-infra E2E 可在“外部 executor 模式”通过。

**范围文件**:
- `executor/src/server.ts`
- `executor/package.json`
- `executor/tsconfig.json`
- `executor/Dockerfile`
- `docker-compose.yml`
- `control-plane/package.json`
- `control-plane/test/e2e/real-infra.e2e.test.ts`

**Tasks**:
- [x] 新增独立 executor 服务（`restore/link/validate/sync`）。
- [x] 支持 executor Bearer token 鉴权。
- [x] executor 接入 RustFS S3，同步 workspace 到对象存储。
- [x] compose 接入 `executor` 服务，`control-plane` 默认走 `EXECUTOR_BASE_URL`。
- [x] 新增外部 executor real E2E 启动脚本（`test:e2e:external-executor`）。
- [x] real E2E 在外部 executor 模式增加健康检查门禁。

**Verification Criteria**:
- [x] `docker compose build executor control-plane` 通过。
- [x] `docker compose up -d rustfs executor pgsql control-plane` 通过。
- [x] `cd control-plane && npm run test:e2e:external-executor` 通过。
- [x] `cd control-plane && npm test` 通过。

**Exit Criteria**:
- 已具备独立 executor 服务与外部 real-infra E2E 验证能力。

---

## Phase 16: 前端 Chat 协议 SDK 化与缺口梳理（已完成）
**Type**: Frontend + Protocol
**Estimated**: 4~8 小时
**目标**: 接入 `ai-sdk/react`，在不改核心后端协议的前提下统一 ChatUI 消息流，同时明确前端剩余研发清单。

**范围文件**:
- `portal/src/App.tsx`
- `portal/package.json`
- `portal/package-lock.json`
- `REMAINING_DEVELOPMENT_TASKS.md`

**Tasks**:
- [x] 在 `portal` 引入 `@ai-sdk/react` 与 `ai` 依赖。
- [x] 使用 `useChat` 管理消息状态与发送动作。
- [x] 实现自定义 `ChatTransport`，兼容现有 `POST /api/runs/start` SSE 事件流。
- [x] 保持 Todo / Human-loop / Run Timeline 面板与原有事件联动能力。
- [x] 新增前端 E2E（覆盖发送消息、流式回包、todo 更新、human-loop 回复）。

**Verification Criteria**:
- [x] `cd portal && npm run build` 通过。
- [x] `cd portal && npm run test`（Playwright E2E）通过。

**Exit Criteria**:
- 前端已使用 `ai-sdk/react`，并且现有 run/todo/human-loop 主链路无回退。

---

## Phase 17: 前端剩余能力（进行中）
**Type**: Frontend + Product
**Estimated**: 10~16 小时
**目标**: 对齐 `设计.md` 中尚未完成的工作台能力，补齐历史会话、文件域、应用商店与稳定性测试。

**范围文件**:
- `portal/src/*`
- `control-plane/src/routes/*`
- `control-plane/src/services/*`
- `control-plane/test/e2e/*`

**Tasks**:
- [x] 前端 E2E 基线：引入 Playwright 并落地首批用例（发送消息、流式回包、todo、human-loop 回复）。
- [x] 历史会话：对接会话列表/加载/恢复（`chatId -> session_id` 映射）。
- [x] 文件域：补齐上传/重命名/删除/在线编辑 + 审计闭环。
- [x] 文件预览增强：文本高亮 + 只读/编辑切换 + 更细粒度分页渲染（图片/PDF/二进制策略保持不变）。
- [x] 应用商店接入：展示可见/可用应用并与会话入口联动。
- [x] Human-loop 体验完善：超时提示（不自动完成）+ 重复回复幂等反馈 + resolved 历史回看已完成。
- [x] 前端流式稳定性：断线重连、游标恢复、异常态提示一致性已完成。

**Verification Criteria**:
- [ ] 前端 E2E 覆盖核心路径并通过 CI。
- [ ] 真实环境联调（compose + external executor）下可稳定完成完整对话闭环。

**Exit Criteria**:
- 前端工作台达到 `设计.md` 的 M2+ 交互完整度基线。

---

## 执行顺序
1. Phase 8（已完成）
2. Phase 9（已完成）
3. Phase 10（已完成）
4. Phase 11（已完成）
5. Phase 12（已完成）
6. Phase 13（已完成）
7. Phase 14（已完成）
8. Phase 15（已完成）
9. Phase 16（已完成）
10. Phase 17（进行中）

## 当前阶段
- `in_progress`: Phase 17（前端 E2E 基线 + 工作台剩余能力补齐）
- `next_commit`: `feat(phase-18): scaffold gateway and observability split`
