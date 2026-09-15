export function parseMcpResponseText(text, contentType = "") {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (contentType.includes("application/json")) {
    return JSON.parse(trimmed);
  }

  const payloads = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    payloads.push(JSON.parse(data));
  }

  if (payloads.length) return payloads[payloads.length - 1];

  // Some compatibility/proxy paths may omit or misreport Content-Type.
  return JSON.parse(trimmed);
}

export async function readMcpResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  return {
    text,
    json: parseMcpResponseText(text, contentType),
    contentType,
  };
}
