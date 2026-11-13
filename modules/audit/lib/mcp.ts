// The row of an App MCP tool call (#658). The cell emits the platform event
// `mcp.tool_called` after every `tools/call` that passed the token check:
// `{ tool, agent_user_id, client, outcome, request_id, at, grant_id?, count? }`, `outcome` one of
// `preview`, `ok`, `forbidden`, `input`, `failed`, `rate_limited`. `count` (#684) is present
// only for `rate_limited`: the cell writes the first refusal of a token in a rate window
// (`count: 1`) and one summary when the window ends (the refusals after the first).
//
// `action` is the event name (the column is `<module>.<verb>`; a tool name is
// not), the tool is the resource, `result` keeps the table's three values and
// the exact outcome stays in `details`, with the owner connector `grant_id`
// when the cell knew it (#748), and the refusal `count` (#684).

import type { AuditInput, Result } from "../services.ts";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function toolCallRow(name: string, p: Record<string, unknown>): AuditInput | null {
  const tool = str(p.tool);
  const agent = str(p.agent_user_id);
  if (!tool || !agent) return null;
  const outcome = str(p.outcome) ?? "failed";
  const result: Result = outcome === "ok" || outcome === "preview" ? "ok" : outcome === "forbidden" || outcome === "rate_limited" ? "denied" : "failed";
  const client = str(p.client);
  const requestId = str(p.request_id);
  const grantId = str(p.grant_id);
  const count = typeof p.count === "number" && Number.isInteger(p.count) && p.count >= 1 ? p.count : null;
  return {
    action: name,
    actor: { kind: "agent", id: agent, ...(client ? { client } : {}) },
    resource: { type: "mcp:Tool", id: tool },
    result,
    details: { tool, outcome, at: p.at, ...(grantId ? { grant_id: grantId } : {}), ...(count !== null ? { count } : {}) },
    ...(requestId ? { request_id: requestId } : {}),
  };
}
