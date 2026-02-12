---
name: rd-workflow-orchestrator
description: Stage-gated software R&D workflow orchestration for end-to-end delivery. Use when a project needs coordinated multi-skill execution across planning, stack decisions, technical research, architecture, backend, frontend, documentation, deployment, and E2E testing, with explicit phase handoffs and quality gates.
---

# Rd Workflow Orchestrator

## Overview

Orchestrate delivery through fixed phases, explicit handoffs, and quality gates.
Route each phase to the most relevant installed skill and do not advance until exit criteria pass.

## Quick Start

1. Confirm scope, timeline, constraints, and non-functional requirements.
2. Read `references/phase-skill-matrix.md`.
3. Select workflow mode:
   - `full`: new project, run all phases.
   - `incremental`: existing project, start from impacted phase.
   - `incident`: production issue, start from research/debug and re-enter normal phases.
4. Create a phase plan using the kickoff template in `references/handoff-templates.md`.
5. Execute one phase at a time with explicit gate checks.

## Workflow

### Phase 0: Intake and Goal Definition

- Produce problem statement, scope boundaries, success metrics, and milestone dates.
- Capture assumptions, dependencies, and risks.
- Block progression if scope or acceptance criteria are ambiguous.

### Phase 1: Planning

- Invoke `$project-planning` to break down milestones into deliverable tasks.
- Split work into thin vertical slices and define owner, estimate, and dependency per slice.
- Freeze a baseline plan and changelog entry.

### Phase 2: Stack and Research

- Invoke `$documentation-lookup` for authoritative docs and version constraints.
- Invoke `$typescript-core` when TypeScript coding rules or strictness policy is needed.
- Record confirmed choices and rejected alternatives with reasons.

### Phase 3: Architecture and Data/API Contracts

- Invoke `$architecture-decision-records` for ADR creation and tradeoff logging.
- Invoke `$api-design-patterns` for API contract shape and error model consistency.
- Invoke `$postgresql-table-design` for schema/index strategy and migration safety.
- Require at least one architecture diagram or contract table before implementation.

### Phase 4: Backend Implementation

- Invoke `$nodejs-backend-typescript` for service structure and handler patterns.
- Keep each change mapped to one planned slice and one acceptance criterion.
- Add or update tests for each behavior change.

### Phase 5: Frontend Implementation

- Invoke `$frontend-react-best-practices` for component and state boundaries.
- Keep UI state transitions explicit and recoverable.
- Align UI contracts strictly with backend API schema.

### Phase 6: Documentation

- Invoke `$api-documentation` to document endpoints, payloads, and error codes.
- Update architecture notes, runbooks, and integration instructions.
- Ensure docs reflect current behavior, not planned behavior.

### Phase 7: Deployment Pipeline

- Invoke `$docker` for image/runtime baseline and container hardening.
- Invoke `$github-actions` for CI gates (lint, unit, integration, security, packaging).
- Define rollback plan and observability checks before deployment.

### Phase 8: End-to-End Verification

- Invoke `$playwright-e2e-testing` for critical user-path tests.
- Invoke `$frontend-testing-best-practices` to prioritize behavior-level coverage.
- Invoke `$test-driven-development` for regression-first fixes.
- Block release if critical path tests are flaky or non-deterministic.

## Orchestration Rules

- Keep at most 2 active phases in parallel; serialize dependent phases.
- Promote a phase only after gate pass and handoff artifact completion.
- Escalate blockers immediately with owner, impact, workaround, and ETA.
- Re-plan when any key assumption changes; do not patch plans silently.

## Missing Skill Fallback

- Detect missing or unavailable skills before phase start.
- Choose the nearest equivalent skill and state the substitution explicitly.
- Continue execution with the same phase gates and artifact requirements.

## Output Contract

- For each phase, produce:
  - `objective`
  - `inputs`
  - `actions`
  - `outputs`
  - `gate_result`
  - `risks`
  - `next_phase`
- Use templates from `references/handoff-templates.md`.
