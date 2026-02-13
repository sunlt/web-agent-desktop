# 日志工具使用说明

## 快速启动

```bash
bash scripts/logs-tool.sh up
```

启动后可访问：
- Dozzle: `http://127.0.0.1:3003`
- Grafana: `http://127.0.0.1:3002`
- Loki API: `http://127.0.0.1:3100`

## 常用命令

```bash
# 实时看默认核心服务日志
bash scripts/logs-tool.sh tail

# 只看指定服务
bash scripts/logs-tool.sh tail gateway control-plane executor-manager

# 查看最近 30 分钟日志
bash scripts/logs-tool.sh since 30m

# 按 runId 过滤（默认回看最近 30 分钟）
bash scripts/logs-tool.sh run run-phase21-123456
```

可选环境变量：
- `LOG_TAIL`：`tail` 模式默认行数（默认 `200`）
- `LOG_SINCE`：`run` 模式日志窗口（默认 `30m`）

## 适用场景

- 多容器联调时快速切换查看（Dozzle）
- 需要时序与聚合查询（Grafana + Loki）
- 命令行快速排障与 runId 定位（`scripts/logs-tool.sh`）
