export interface BoundedValueOptions {
  maxStringChars?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxDepth?: number;
}

const DEFAULTS: Required<BoundedValueOptions> = {
  maxStringChars: 2_000,
  maxArrayItems: 40,
  maxObjectKeys: 80,
  maxDepth: 5,
};

/**
 * Make arbitrary diagnostic data safe to retain in long-lived in-memory logs or
 * append-only audit records. This is deliberately lossy: operational logs need a
 * useful preview, not a second copy of multi-megabyte MCP arguments/results.
 */
export function boundDiagnosticValue(
  value: unknown,
  options: BoundedValueOptions = {}
): unknown {
  const limits = { ...DEFAULTS, ...options };
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input;
    if (typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "string") {
      if (input.length <= limits.maxStringChars) return input;
      return `${input.slice(0, limits.maxStringChars)}… [truncated ${input.length - limits.maxStringChars} chars]`;
    }
    if (typeof input === "function" || typeof input === "symbol") return String(input);
    if (Buffer.isBuffer(input)) {
      return `<Buffer ${input.length} bytes>`;
    }
    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) {
      return {
        name: input.name,
        message: walk(input.message, depth + 1),
      };
    }
    if (typeof input !== "object") return String(input);
    if (depth >= limits.maxDepth) return "[depth limit]";
    if (seen.has(input as object)) return "[circular]";
    seen.add(input as object);

    if (Array.isArray(input)) {
      const bounded = input.slice(0, limits.maxArrayItems).map((item) => walk(item, depth + 1));
      if (input.length > limits.maxArrayItems) {
        bounded.push(`[+${input.length - limits.maxArrayItems} more item(s)]`);
      }
      return bounded;
    }

    const entries = Object.entries(input as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, limits.maxObjectKeys)) {
      out[key] = walk(item, depth + 1);
    }
    if (entries.length > limits.maxObjectKeys) {
      out.__truncated_keys__ = entries.length - limits.maxObjectKeys;
    }
    return out;
  };

  return walk(value, 0);
}
