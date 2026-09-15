import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireCommandAllowed, requireWriteAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import {
  acceptEditTransaction,
  beginEditTransaction,
  getEditTransaction,
  getEditTransactionConfig,
  listEditTransactions,
  previewEditTransaction,
  recordTransactionVerification,
  rollbackEditTransaction,
  withEditTransactionLock,
} from "../lib/edit-transaction-store.js";
import {
  compactVerificationOutput,
  discoverVerificationRecipe,
  type VerificationCommand,
} from "../lib/verification.js";
import { runOneShotCommand } from "./shell.js";

const actionSchema = z.enum(["begin", "status", "list", "preview", "verify", "accept", "rollback"]);
const commandSchema = z.object({
  label: z.string().min(1).max(120),
  command: z.string().min(1).max(100_000),
  timeout_seconds: z.number().int().min(5).max(3600).optional().default(180),
});

export function registerEditTransactionTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "edit_transaction",
    {
      title: "Edit Transaction",
      description:
        "Transactional editing for regular ChatGPT. Begin a durable transaction, pass transaction_id to supported file-edit tools, preview all touched-file changes, verify them, then accept or rollback only that transaction. Rollback detects out-of-band file changes unless force=true.",
      inputSchema: {
        action: actionSchema,
        id: z.string().optional(),
        workspace: z.string().optional(),
        label: z.string().max(200).optional(),
        limit: z.number().int().positive().max(100).optional().default(20),
        force: z.boolean().optional().default(false),
        preset: z.enum(["quick", "full", "custom"]).optional().default("quick"),
        commands: z.array(commandSchema).min(1).max(12).optional(),
        stop_on_failure: z.boolean().optional().default(false),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, id, workspace, label, limit, force, preset, commands, stop_on_failure }) => {
      if (action === "list") {
        const transactions = await listEditTransactions(limit);
        return toolResult("edit_transaction", {
          action,
          config: getEditTransactionConfig(),
          transactions,
        }, { summary: `${transactions.length} edit transaction(s)` });
      }

      if (action === "begin") {
        requireWriteAllowed();
        const root = workspace ? await validatePath(workspace) : defaultCwd;
        const transaction = await beginEditTransaction(root, label);
        await audit({
          tool: "edit_transaction",
          action: "begin",
          target: root,
          status: "ok",
          details: { id: transaction.id, label: transaction.label },
        });
        return toolResult("edit_transaction", {
          action,
          transaction,
          hint: "Pass transaction_id to write_file/edit_file/multi_edit/replace_regex/apply_patch/delete_file/copy_file/move_file while this transaction is active.",
        }, { summary: `began ${transaction.id}` });
      }

      if (!id) throw new Error(`id is required for edit_transaction action '${action}'`);
      return withEditTransactionLock(id, async () => {
      const current = await getEditTransaction(id);
      await validatePath(current.workspace);
      for (const snapshot of current.snapshots) await validatePath(snapshot.path);

      if (action === "status") {
        return toolResult("edit_transaction", { action, transaction: current }, { summary: `${id}: ${current.status}` });
      }

      if (action === "preview") {
        const preview = await previewEditTransaction(id);
        return toolResult("edit_transaction", { action, ...preview }, {
          summary: `${id}: ${preview.changed_files} changed file(s)${preview.truncated ? ", preview truncated" : ""}`,
        });
      }

      if (action === "verify") {
        const transaction = current;
        if (transaction.status !== "active") throw new Error(`Edit transaction ${id} is ${transaction.status}, not active`);
        if (preset === "custom" && !commands?.length) throw new Error("commands are required when preset=custom");
        if (preset !== "custom" && commands?.length) throw new Error("commands may only be supplied when preset=custom");
        const discovered = preset === "custom"
          ? { source: "custom" as const, commands: commands as VerificationCommand[] }
          : await discoverVerificationRecipe(transaction.workspace, preset);
        if (!discovered.commands.length) {
          return toolResult("edit_transaction", {
            action,
            transaction,
            preset,
            source: discovered.source,
            results: [],
          }, { ok: false, summary: "no verification checks discovered" });
        }

        const results: Array<{
          label: string;
          command: string;
          exit_code: number;
          duration_ms: number;
          timed_out: boolean;
          excerpt: string;
          output_chars: number;
          truncated: boolean;
        }> = [];
        for (const check of discovered.commands) {
          requireCommandAllowed(check.command, transaction.workspace);
          const result = await runOneShotCommand(check.command, transaction.workspace, check.timeout_seconds * 1000);
          const compact = compactVerificationOutput(result.stdout, result.stderr);
          results.push({
            label: check.label,
            command: check.command,
            exit_code: result.exit_code,
            duration_ms: result.duration_ms,
            timed_out: result.timed_out,
            ...compact,
          });
          if (stop_on_failure && result.exit_code !== 0) break;
        }
        const failed = results.filter((result) => result.exit_code !== 0).length;
        const passed = results.length - failed;
        const durationMs = results.reduce((sum, result) => sum + result.duration_ms, 0);
        const recorded = await recordTransactionVerification(id, {
          at: new Date().toISOString(),
          preset,
          passed,
          failed,
          duration_ms: durationMs,
          results: results.map((result) => ({
            label: result.label,
            command: result.command,
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            excerpt: result.excerpt,
          })),
        });
        await audit({
          tool: "edit_transaction",
          action: "verify",
          target: transaction.workspace,
          status: failed ? "error" : "ok",
          details: { id, preset, checks: results.length, failed, duration_ms: durationMs },
        });
        return toolResult("edit_transaction", {
          action,
          transaction: recorded,
          preset,
          source: discovered.source,
          results,
          passed,
          failed,
          duration_ms: durationMs,
          stopped_early: stop_on_failure && results.length < discovered.commands.length,
        }, {
          ok: failed === 0,
          summary: `${passed}/${results.length} transaction verification check(s) passed${failed ? `, ${failed} failed` : ""}`,
        });
      }

      if (action === "accept") {
        requireWriteAllowed();
        const transaction = await acceptEditTransaction(id);
        await audit({
          tool: "edit_transaction",
          action: "accept",
          target: transaction.workspace,
          status: "ok",
          details: { id, files: transaction.snapshots.length, edits: transaction.edits.length },
        });
        return toolResult("edit_transaction", { action, transaction }, { summary: `accepted ${id}` });
      }

      requireWriteAllowed();
      const rollback = await rollbackEditTransaction(id, force);
      await audit({
        tool: "edit_transaction",
        action: "rollback",
        target: rollback.transaction.workspace,
        status: rollback.rolled_back ? "ok" : "error",
        details: { id, force, restored: rollback.restored.length, deleted: rollback.deleted.length, conflicts: rollback.conflicts.length },
      });
      return toolResult("edit_transaction", { action, ...rollback }, {
        ok: rollback.rolled_back,
        summary: rollback.rolled_back
          ? `rolled back ${id}: ${rollback.restored.length} restored, ${rollback.deleted.length} deleted`
          : `rollback blocked by ${rollback.conflicts.length} conflict(s)`,
      });
      });
    }
  );
}
