import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "view_image",
    {
      title: "View Local Image",
      description:
        "Load a local PNG/JPEG/WEBP/GIF and return it as MCP image content so ChatGPT can inspect an arbitrary image path on this machine. Prefer this over read_file_base64 for visual analysis.",
      inputSchema: {
        path: z.string(),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath }) => {
      const validPath = await validatePath(filePath);
      const stat = await fs.stat(validPath);
      if (!stat.isFile()) throw new Error("Path is not a regular file");
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`Image is too large (${stat.size} bytes). Maximum supported size is ${MAX_IMAGE_BYTES} bytes.`);
      }

      const mimeType = MIME_BY_EXTENSION[path.extname(validPath).toLowerCase()];
      if (!mimeType) {
        throw new Error("Unsupported image format. Supported extensions: .png, .jpg, .jpeg, .webp, .gif");
      }

      const buffer = await fs.readFile(validPath);
      await audit({
        tool: "view_image",
        action: "read",
        target: validPath,
        status: "ok",
        details: { bytes: buffer.length, mime_type: mimeType },
      });

      const base = toolResult(
        "view_image",
        { path: validPath, bytes: buffer.length, mime_type: mimeType },
        { summary: `image: ${path.basename(validPath)} (${buffer.length} bytes)` }
      );

      return {
        ...base,
        content: [
          ...base.content,
          {
            type: "image" as const,
            data: buffer.toString("base64"),
            mimeType,
          },
        ],
      };
    }
  );
}
