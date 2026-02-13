# Executor Provider Runtime 重构计划

更新时间：2026-02-13

## 1. 背景与问题

当前真实 provider 运行链路仍包含 `control-plane` 本地 provider adapter 执行路径（容器内通过 CLI 代理脚本转发），导致职责边界不清晰：

1. `control-plane` 既做编排又介入执行。
2. provider CLI 入口存在于 `control-plane` 镜像，和“执行只在 executor”的目标冲突。
3. 跨服务交互未完全收口到 `HTTP/SSE`。

## 2. 目标架构（改造后）

1. 外部入口：`portal -> gateway`。
2. 编排入口：`gateway -> control-plane`。
3. 执行链路：`control-plane -> executor-manager -> executor`（仅 HTTP/SSE）。
4. provider CLI 真实执行位置：仅 `executor`。
5. `control-plane` 不再依赖 provider CLI 本地二进制。

## 3. 分阶段实施

### Phase A：执行接口下沉到 executor

目标：在 `executor` 提供独立 provider-run API，支持 start/stream/stop/human-loop-reply。

范围：
- `executor/src/providers/*`（新增）
- `executor/src/services/provider-runner.ts`（新增）
- `executor/src/services/stream-bus.ts`（新增）
- `executor/src/server.ts`
- `executor/package.json`

接口草案：
- `POST /provider-runs/start`
- `GET /provider-runs/:runId/stream`（SSE，支持 cursor/Last-Event-ID）
- `POST /provider-runs/:runId/stop`
- `POST /provider-runs/:runId/human-loop/reply`

验收：
- `executor` 可独立完成 provider run 生命周期。
- `stop` 与 `human-loop/reply` 均可在运行中生效。

### Phase B：executor-manager 提供统一执行入口

目标：`executor-manager` 透传 provider-run API 到 `executor`，对 control-plane 暴露稳定入口。

范围：
- `executor-manager/src/routes/provider-runs.ts`（新增）
- `executor-manager/src/app.ts`

验收：
- `executor-manager` 对外可用：`/api/provider-runs/*`。
- SSE 可无损透传，支持长连接与断开中止。

### Phase C：control-plane 切换远程 provider adapter

目标：默认 provider adapter 不再本地执行，改为远程调用 executor-manager。

范围：
- `control-plane/src/providers/executor-manager-provider.ts`（新增）
- `control-plane/src/app.ts`
- `control-plane/Dockerfile`
- `docker-compose.yml`

验收：
- `control-plane` 镜像无需 provider CLI 代理脚本。
- `POST /api/runs/start` 行为保持兼容。

### Phase D：脚本/门禁与文档收口

目标：修复 precheck/stress 对旧“control-plane CLI 代理”假设，统一到新链路。

范围：
- `scripts/provider-runtime-health-check.sh`
- `scripts/e2e-portal-real-provider-stress.sh`
- `PHASE_HANDOFF.md`
- `REMAINING_DEVELOPMENT_TASKS.md`

验收：
- 健康检查基于 `executor-manager/executor` 而非 `control-plane` 本地 CLI。

### Phase E：control-plane 残留 provider 依赖清理

目标：彻底移除 `control-plane` 本地 provider runtime 代码与 `ai-sdk-provider-*` 依赖，确保 provider 执行职责仅在 `executor`。

范围：
- `control-plane/src/providers/claude-code-provider.ts`（删除）
- `control-plane/src/providers/opencode-provider.ts`（删除）
- `control-plane/src/providers/codex-cli-provider.ts`（删除）
- `control-plane/src/providers/runtime-utils.ts`（删除）
- `control-plane/test/provider-registry.test.ts`
- `control-plane/package.json`
- `control-plane/package-lock.json`

验收：
- `control-plane` 源码不再 import `ai-sdk-provider-*`。
- `npm run lint && npm run typecheck && npm test`（control-plane）通过。

### Phase F：协议命名收口（`codex-app-server` 兼容）

目标：在不破坏现有 `codex-cli` 客户端的前提下，全链路接受并优先使用 `codex-app-server` 命名，降低“CLI 执行在 control-plane”的认知歧义。

范围：
- `control-plane/src/providers/types.ts`
- `control-plane/src/providers/provider-registry.ts`
- `control-plane/src/routes/runs.ts`
- `control-plane/src/routes/run-queue.ts`
- `executor-manager/src/routes/provider-runs.ts`
- `executor/src/providers/types.ts`
- `executor/src/providers/provider-registry.ts`
- `executor/src/server.ts`
- `portal/src/App.tsx`
- `portal/src/workbench/transport.ts`
- `portal/src/workbench/use-run-chat.ts`
- `portal/e2e/tests/*`
- `scripts/provider-runtime-health-check.sh`
- `scripts/e2e-portal-real-provider-stress.sh`
- `scripts/e2e-full-conversation-real-env.sh`

验收：
- 以上路由/服务均可接受 `provider=codex-app-server`。
- portal 默认 provider 切换为 `codex-app-server`。
- 保留 `codex-cli` 向后兼容。

### Phase G：真实 Provider 失败可诊断性增强

目标：收敛 Phase21 中 `unknown_failure/provider_no_output` 的排障盲区，确保失败时有明确 reason 与可用证据。

范围：
- `executor/src/providers/types.ts`
- `executor/src/providers/runtime-utils.ts`
- `executor/src/services/provider-runner.ts`
- `control-plane/src/providers/types.ts`
- `control-plane/src/services/run-orchestrator.ts`
- `scripts/e2e-portal-real-provider-stress.sh`

验收：
- `run.status(detail)` 可携带失败原因（例如 `finish_reason:error`）。
- 压测失败样本内 `sse.raw.txt` 非空并包含完整事件。
- 压测报告可从 `unknown_failure` 收敛到可操作分类（如 `auth_missing`）。

### Phase H：凭据治理与超时基线收敛

目标：将真实 provider 路径从“能诊断”推进到“可稳定门禁”，区分环境未就绪与真实回归，并降低短超时导致的假失败。

范围：
- `.github/workflows/ci.yml`
- `scripts/provider-runtime-health-check.sh`
- `scripts/e2e-portal-real-provider-stress.sh`

验收：
- CI `compose up` 步骤显式注入 provider secrets。
- health-check 报告包含 `readinessCategory/blockingReason`（`ready`/`environment_not_ready`/`runtime_unhealthy`）。
- stress 脚本正确记录 `curlExit`，超时归类为 `timeout`（不再误报 `unknown_failure`）。
- 实测本机凭据（`~/.codex/auth.json` 注入 executor）下，长超时窗口可得到 `succeeded` 样本。

### Phase I：本地凭据注入产品化与 App Runtime 策略化

目标：将本机凭据接入从“手工临时注入”升级为可复用能力，并支持在 app 注册时声明 provider/model/credential env/timeout，打通到运行链路。

范围：
- `scripts/bootstrap-local-provider-env.sh`
- `docker-compose.yml`
- `scripts/provider-runtime-health-check.sh`
- `scripts/e2e-portal-real-provider-stress.sh`
- `control-plane/sql/004_app_runtime_profiles.sql`
- `control-plane/src/repositories/rbac-repository.ts`
- `control-plane/src/repositories/in-memory-rbac-repository.ts`
- `control-plane/src/repositories/postgres-rbac-repository.ts`
- `control-plane/src/routes/apps.ts`
- `control-plane/src/routes/runs.ts`
- `executor-manager/src/config/provider-timeout-template.ts`
- `executor-manager/src/routes/provider-runs.ts`
- `portal/src/App.tsx`
- `portal/src/workbench/use-run-chat.ts`

验收：
- 可从 `~/.claude/settings.json` 与 `~/.config/opencode/opencode.json` 自动抽取凭据并注入 `executor` 环境变量。
- `POST /api/apps/register` 可配置 runtimeDefaults（provider/model/credential env/providerOptions/timeout）。
- 绑定 `executionProfile` 启动 run 时，app runtimeDefaults 可覆盖 provider/model 并合并注入 env。
- executor-manager 超时策略支持：
  - `providerOptions.timeoutMs/runTimeoutMs` 显式覆盖；
  - provider/model 模板；
  - 默认 `EXECUTOR_RUN_TIMEOUT_MS` 回退。

## 4. 兼容与回滚策略

1. 保留 `CONTROL_PLANE_PROVIDER_MODE=scripted` 作为测试与回滚保底。
2. 若 Phase C 联调失败，可临时回切到旧 adapter（不变更 API 协议）。
3. 每阶段独立提交，确保可按 commit 粒度回退。

## 5. 阶段提交规范

1. 每阶段结束执行：`eslint` + `ts typecheck` + 必要构建/联调。
2. 提交信息：`feat(phase-executor-runtime-<x>): ...`。
3. `PHASE_HANDOFF.md` 追加每阶段 gate 结果与剩余风险。

## 6. 执行状态

- Phase A：已完成（commit: `7413478`）
- Phase B：已完成（commit: `7413478`）
- Phase C：已完成（commit: `7413478` + `c0b36e2` + `41c3caf`）
- Phase D：已完成（commit: `f38f9aa`）
- Phase E：已完成（commit: `e4ece48`）
- Phase F：已完成（commit: `958ff43`）
- Phase G：已完成（commit: `55a28ce`）
- Phase H：已完成（commit: `4f1f8c2`）
- Phase I：进行中（本次提交，剩余真实 provider 可用性收敛）
