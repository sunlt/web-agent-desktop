# Quality Gates

## 必过检查
- `control-plane`: `npm run lint` + `npm run typecheck`
- `portal`: `npm run lint` + `npm run typecheck`
- `executor`: `npm run lint` + `npm run typecheck`

## 统一提交前检查
- 脚本：`scripts/pre-commit-check.sh`
- Git Hook：`.githooks/pre-commit`
- 本仓库已配置：`git config core.hooksPath .githooks`

## TS/TSX 文件长度约束
- ESLint 规则：`max-lines`
- 限制：每个 `.ts/.tsx` 文件最多 `800` 行（`skipBlankLines: true`，即空行不计入）
- 超限处理：必须拆分模块，不允许通过放宽阈值绕过
