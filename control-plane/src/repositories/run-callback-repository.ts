import type {
  HumanLoopRepository,
  RunContextRepository,
  RunEventRepository,
  RunStateRepository,
  TodoRepository,
} from "../services/callback-handler.js";

export interface RunCallbackRepository
  extends RunEventRepository,
    RunContextRepository,
    RunStateRepository,
    TodoRepository,
    HumanLoopRepository {
  bindRun(runId: string, sessionId: string): Promise<void> | void;
}
