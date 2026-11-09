import { sameResolvedPath } from "./path-identity.js";
import { getAgentTaskProgress, type AgentTaskRecord } from "./agent-task-store.js";
import type { CodingLoopRecord } from "./coding-loop-store.js";
import type { EditTransactionRecord } from "./edit-transaction-store.js";
import { summarizeTaskActivity, type TaskActivityWorker } from "./task-activity.js";

/**
 * Project-scoped, read-only recovery assessment.
 *
 * No task, loop, transaction, file snapshot, or workspace is updated here.
 * Staleness is a review signal, NEVER evidence that work may be discarded.
 * Returned transaction data contains counts only, not captured file contents.
 */
export function buildWorkspaceRecoveryReview(input: {
  workspace: string;
  tasks: readonly AgentTaskRecord[];
  loops: readonly CodingLoopRecord[];
  transactions: readonly EditTransactionRecord[];
  workers: readonly TaskActivityWorker[];
  staleHours: number;
  taskId?: string;
  now?: number;
  maxFindings?: number;
}) {
  const now = input.now ?? Date.now();
  const cutoff = now - input.staleHours * 3_600_000;
  const maxFindings = Math.max(1, Math.min(50, input.maxFindings ?? 50));
  const belongs = (workspace: string | undefined) =>
    typeof workspace === "string" && sameResolvedPath(workspace, input.workspace);
  const recentEnoughToReview = (timestamp: string | undefined) => {
    const time = Date.parse(timestamp ?? "");
    return Number.isFinite(time) && time <= cutoff;
  };
  const ageHours = (timestamp: string) =>
    Math.max(0, Math.round((now - Date.parse(timestamp)) / 360_000) / 10);

  const projectTasks = input.tasks.filter((task) =>
    belongs(task.workspace) && (!input.taskId || task.id === input.taskId));
  const projectLoops = input.loops.filter((loop) =>
    (belongs(loop.source_workspace) || belongs(loop.workspace)) &&
    (!input.taskId || loop.task_id === input.taskId));
  const projectTransactions = input.transactions.filter((transaction) => {
    // A loop may use a disposable worktree outside its source project.
    // Include only an exact transaction/loop-workspace match, not any
    // transaction in the same parent directory or in another project.
    const linkedLoop = projectLoops.find((loop) =>
      loop.transaction_id === transaction.id &&
      sameResolvedPath(loop.workspace, transaction.workspace));
    const inProject = belongs(transaction.workspace);
    return (inProject || Boolean(linkedLoop)) && (!input.taskId || Boolean(linkedLoop));
  });

  const staleTasks = projectTasks
    .filter((task) => (task.status === "active" || task.status === "blocked") &&
      recentEnoughToReview(task.updated_at))
    .map((task) => {
      const execution = summarizeTaskActivity(task, projectLoops, input.workers);
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        updated_at: task.updated_at,
        age_hours: ageHours(task.updated_at),
        progress: getAgentTaskProgress(task),
        execution,
        suggested_action: execution.running_worker_count
          ? "inspect_running_worker"
          : execution.linked_loop?.status === "completed"
            ? "inspect_and_finish_task_manually"
            : execution.linked_loop?.status === "active"
              ? "resume_loop_or_explicitly_abandon"
              : "resume_or_mark_blocked_with_reason",
        auto_modified: false,
      };
    });

  const staleLoops = projectLoops
    .filter((loop) => loop.status === "active" && recentEnoughToReview(loop.updated_at))
    .map((loop) => {
      const workers = input.workers.filter((worker) => worker.running && loop.task_id &&
        worker.task_id === loop.task_id);
      const transaction = projectTransactions.find((item) => item.id === loop.transaction_id);
      return {
        id: loop.id,
        status: loop.status,
        phase: loop.phase,
        task_id: loop.task_id ?? null,
        transaction_id: loop.transaction_id,
        transaction_status: transaction?.status ?? null,
        updated_at: loop.updated_at,
        age_hours: ageHours(loop.updated_at),
        running_worker_count: workers.length,
        suggested_action: workers.length
          ? "inspect_running_worker"
          : "inspect_and_resume_or_explicitly_abandon_loop",
        auto_modified: false,
      };
    });

  const staleTransactions = projectTransactions
    .filter((transaction) => transaction.status === "active" &&
      recentEnoughToReview(transaction.updated_at))
    .map((transaction) => {
      const linked = projectLoops.find((loop) => loop.transaction_id === transaction.id);
      return {
        id: transaction.id,
        status: transaction.status,
        label: transaction.label ?? null,
        updated_at: transaction.updated_at,
        age_hours: ageHours(transaction.updated_at),
        files: transaction.snapshots.length,
        edits: transaction.edits.length,
        linked_loop: linked ? { id: linked.id, status: linked.status } : null,
        suggested_action: linked?.status === "active"
          ? "inspect_active_loop_before_transaction_changes"
          : "inspect_and_verify_transaction_before_manual_accept_or_rollback",
        auto_modified: false,
      };
    });

  return {
    workspace: input.workspace,
    threshold_hours: input.staleHours,
    selected_task_id: input.taskId ?? null,
    findings: staleTasks.slice(0, maxFindings),
    count: staleTasks.length,
    stale_loops: staleLoops.slice(0, maxFindings),
    stale_transactions: staleTransactions.slice(0, maxFindings),
    counts: {
      tasks: staleTasks.length,
      coding_loops: staleLoops.length,
      edit_transactions: staleTransactions.length,
    },
    scanned: {
      tasks: projectTasks.length,
      coding_loops: projectLoops.length,
      edit_transactions: projectTransactions.length,
    },
    truncated: {
      tasks: staleTasks.length > maxFindings,
      coding_loops: staleLoops.length > maxFindings,
      edit_transactions: staleTransactions.length > maxFindings,
    },
    note: "Read-only review. Stale does not mean safe to finish, accept, rollback, abandon, archive, or delete. No state was modified.",
  };
}