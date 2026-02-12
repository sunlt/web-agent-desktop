# Phase Skill Matrix

Use this matrix to map each project phase to the primary skill set, required inputs, mandatory outputs, and gate checks.

| Phase | Primary Skills | Required Inputs | Mandatory Outputs | Gate Check |
| --- | --- | --- | --- | --- |
| 0 Intake | `$rd-workflow-orchestrator` | Problem statement, constraints, deadline | Scope brief, success metrics, risk list | Scope and acceptance criteria are testable |
| 1 Planning | `$project-planning` | Scope brief, metrics, constraints | Phase roadmap, task breakdown, dependency map | Tasks are decomposed and sequenced |
| 2 Research | `$documentation-lookup`, `$typescript-core` | Tech candidates, version targets | Decision log, compatibility notes | Decisions cite authoritative references |
| 3 Architecture | `$architecture-decision-records`, `$api-design-patterns`, `$postgresql-table-design` | Decision log, requirements | ADRs, API contracts, schema draft | Contracts and schema reviewed for consistency |
| 4 Backend | `$nodejs-backend-typescript`, `$test-driven-development` | ADRs, API/schema contracts | Backend implementation, tests, migration scripts | Unit/integration tests pass |
| 5 Frontend | `$frontend-react-best-practices`, `$frontend-testing-best-practices` | API contracts, UX requirements | UI implementation, component tests | UI behavior matches contracts |
| 6 Documentation | `$api-documentation` | Implemented features, runbook details | API docs, runbook updates, architecture notes | Docs match actual behavior |
| 7 Deployment | `$docker`, `$github-actions` | Build/runtime requirements | Container config, CI pipeline, rollout/rollback plan | CI pipeline green and rollback validated |
| 8 E2E | `$playwright-e2e-testing`, `$test-driven-development` | Staging environment, test accounts | E2E suite, regression report, release decision | Critical-path E2E and regression pass |

## Parallelization Guidance

- Parallelize only phases with no hard dependency boundary.
- Prefer parallel tasks inside one phase over cross-phase overlap.
- Keep architecture contract updates serialized to avoid drift.

## Escalation Guidance

- Escalate immediately when a gate fails twice.
- Produce blocker report with:
  - blocker summary
  - impacted phase
  - owner
  - expected delay
  - fallback option
