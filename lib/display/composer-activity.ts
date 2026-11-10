import type { TodoPhase } from "../pi-types";
import type { SubagentInfo } from "../subagent-types";

export function isActiveComposerSubagent(subagent: SubagentInfo): boolean {
  return subagent.source !== "history" && subagent.status === "started";
}

/** Terminal plans and historical rosters must not reserve composer space. */
export function composerPanelVisibility(todoPhases: TodoPhase[], subagents: SubagentInfo[]) {
  return {
    tasks: todoPhases.some((phase) => phase.tasks.some((task) => task.status !== "completed" && task.status !== "abandoned")),
    subagents: subagents.some(isActiveComposerSubagent),
  };
}
