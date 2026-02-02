# 通用 Agent Chat 平台架构设计方案 (V3)

本方案在 V2 基础上增加了 **MinIO 存储集成**、**精细化角色控制**、**配置包简化** 以及 **多引擎扩展**。

## 1. 核心模型：App Registry & Context

### 1.1 App 注册中心 (Registry)

- **管理角色**: **系统管理员** (System Admin)。负责 App 的上架、版本管理及全局配置维护。
- **配置模板**: 简化为 **ZIP 归档 (`config/template.zip`)**。启动时自动解压覆盖到工作目录。
- **存储**: 配置文件存储于 MinIO 独立的 `configs` Bucket。

### 1.2 运行时模型与存储隔离

引入 **MinIO** 对象存储作为核心数据层：

- **存储架构**:
  - `user-data/{userId}/`: 用户个人工作空间，隔离不可见。
  - `shared-scenarios/{appId}/`: 业务场景共享数据。
  - `configs/`: App 配置模板 ZIP。
  - `knowledge-base/`: 知识库文档。

- **挂载机制**:
  - 利用 `rclone` 或 `s3fs` 将 MinIO Bucket 挂载到本地文件系统。
  - **Files App**: 仅允许访问挂载点路径，严禁访问容器根目录。
  - **WorkDir**: 用户在启动 App 时，只能从其 MinIO 挂载路径 (`/mnt/user-data/...`) 中选择工作目录。

## 2. 后端架构 (Agent Service)

### 2.1 适配层 (Agent Adapter)

扩展支持以下 CLI 引擎：

- `opencode` (Opencode AI)
- `claude-code` (Anthropic)
- `gemini-cli` (Google)
- `qwen-code` (Qwen CLI) [NEW]
- `codex-cli` (OpenAI) [NEW]
- `openclaw` (OpenClaw) [NEW]

### 2.2 知识库 RAG (Knowledge Link)

- **管理角色**: **应用管理员** (App Admin)。负责维护特定业务维度的文档版本与权限。
- **存储增强**: 源文档 (Markdown/PDF) 存储于 MinIO `knowledge-base` Bucket。
- **版本控制**: 基于 Git 管理文档变更历史。
- **引擎集成**: PageIndex + UltraRag 双引擎支持。

## 3. 核心应用集

### 3.1 默认管理应用

| App ID            | 名称         | 管理角色       | 职责                                           |
| :---------------- | :----------- | :------------- | :--------------------------------------------- |
| **App Registry**  | 应用注册中心 | **系统管理员** | 管理 App 定义、上传 Config ZIP、设置默认权限。 |
| **Knowledge Mgr** | 知识库管理   | **应用管理员** | 管理 Git 文档库、MinIO 文档桶及 RAG 索引构建。 |
| **Market**        | 应用市场     | 普通用户       | 浏览与安装 App。                               |

### 3.2 基础工具集

保留 Terminal, Files, Proxy，并预装通用 AI App：Gemini, Codex, Claude Code, Opencode, **OpenClaw**。
_注：Files App 需改造为仅展示 MinIO 挂载目录。_

## 4. 实施路线图

### Phase 1: 存储基座与核心服务

- [ ] **Infrastructure**: 部署 MinIO 服务，配置 Bucket (`user-data`, `configs`, `kb`) 与 Access Policy。
- [ ] **Data Support**: 在 `agent-runtime` 中配置 MinIO 挂载脚本 (`s3fs`)。
- [ ] **Backend**: 搭建 `agent-chat` 服务，集成 AI SDK 与多引擎适配器。

### Phase 2: 管理应用与业务模型

- [ ] **Registry**: 开发系统管理员控制台，支持 ZIP 上传。
- [ ] **Knowledge**: 开发应用管理员控制台，集成 Git/RAG 流程。
- [ ] **Launcher**: 改造启动流程，强制从 MinIO 路径选择 WorkDir 并解压配置 ZIP。

### Phase 3: 前端重构与完整集成

- [ ] **Frontend**: 全面 React 重构 Portal。
- [ ] **Notification**: 跨组件通知集成。
