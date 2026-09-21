export type ToolErrorCategory =
  | "timeout"
  | "transient"
  | "expected_no_match"
  | "command_failure"
  | "conflict"
  | "permission"
  | "transport"
  | "not_found"
  | "invalid_input"
  | "unknown";

export interface ToolFailureMetadata {
  category: ToolErrorCategory;
  retryable: boolean;
  suggested_action?: string;
}

export function classifyToolFailure(input: {
  message?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  command?: string;
}): ToolFailureMetadata {
  const message = (input.message || "").toLowerCase();
  const command = (input.command || "").toLowerCase();

  if (input.timedOut || input.exitCode === 124 || /timed?\s*out|timeout/.test(message)) {
    return { category: "timeout", retryable: true, suggested_action: "retry with a longer timeout or run as a background process" };
  }
  if (/eacces|eperm|access denied|permission denied|not permitted/.test(message)) {
    return { category: "permission", retryable: false, suggested_action: "check the Local Coder permission profile and OS permissions" };
  }
  if (/conflict|changed since|stale baseline|lock conflict/.test(message)) {
    return { category: "conflict", retryable: false, suggested_action: "refresh state and reconcile the conflicting changes before retrying" };
  }
  if (/session terminated|stream canceled|econnreset|econnrefused|socket hang up|transport/.test(message)) {
    return { category: "transport", retryable: true, suggested_action: "reconnect or refresh the connector, then retry the same idempotent operation" };
  }
  if (/enoent|not found|unknown process id|unknown operation id/.test(message)) {
    return { category: "not_found", retryable: false, suggested_action: "refresh/list current state and use an existing identifier or path" };
  }
  if (/invalid|must provide|required|unsupported/.test(message)) {
    return { category: "invalid_input", retryable: false, suggested_action: "correct the request parameters before retrying" };
  }
  if (input.exitCode === 1 && /(?:^|\s)(grep|rg|git grep|select-string)(?:\s|$)/.test(command)) {
    return { category: "expected_no_match", retryable: false, suggested_action: "treat as an empty search result unless the command reported another error" };
  }
  if (/temporar|busy|try again|resource unavailable|rate limit/.test(message)) {
    return { category: "transient", retryable: true, suggested_action: "retry after the transient condition clears" };
  }
  if (input.exitCode != null && input.exitCode !== 0) {
    return { category: "command_failure", retryable: false, suggested_action: "inspect stderr/output and fix the underlying command failure" };
  }
  return { category: "unknown", retryable: false };
}
