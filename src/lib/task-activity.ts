/**
 * Persistent tasks and coding loops are records, not autonomous workers.
 * This is intentionally read-only: diagnostics must never finish a task.
 */
export interface TaskActivityLoop {
  id: string;
  task_id?: string;
  status: string;
  managed_task?: boolean;
  updated_at?: string;
}

export interface TaskActivityWorker {
  id: string;
  task_id?: string;
  running: boolean;
}

export function summarizeTaskActivity(
  task: { id: string; status: string },
  loops: readonly TaskActivityLoop[],
  workers: readonly TaskActivityWorker[]
) {
  const live = workers.filter((worker) => worker.running && worker.task_id === task.id);
  const linked = loops
    .filter((loop) => loop.task_id === task.id)
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const current = linked.find((loop) => loop.status === "active") || linked[0];

  let explanation = "Task status describes a saved plan, not an executing agent.";
  if (live.length) {
    explanation = "A registered process linked to this task is currently running.";
  } else if (current?.status === "active") {
    explanation = "A coding loop is active, but there is no registered running worker; its next step requires an agent call.";
  } else if (current?.status === "completed" && !current.managed_task &&
    (task.status === "active" || task.status === "blocked")) {
    explanation = "The coding loop completed, but the task was externally managed; review and finish the task explicitly.";
  } else if (current?.status === "completed" && current.managed_task &&
    (task.status === "active" || task.status === "blocked")) {
    explanation = "The managed coding loop completed but the task remains active; inspect lifecycle reconciliation.";
  }

  return {
    status_scope: "persistent_plan" as const,
    running_worker_count: live.length,
    worker_ids: live.map((worker) => worker.id).slice(0, 8),
    linked_loop: current ? { id: current.id, status: current.status, managed_task: Boolean(current.managed_task) } : null,
    explanation,
  };
}