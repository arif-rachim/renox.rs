// `renox mcp`: the local platform MCP server (docs/20-ai-agents-mcp.md,
// section 1; P21). JSON-RPC 2.0 over stdio, one message per line (the MCP
// stdio transport). stdout carries only protocol messages; diagnostics go to
// stderr. Capabilities: tools (tools.ts) and resources (resources.ts); no
// prompts, no subscriptions, no sampling.

import pkg from "../../package.json" with { type: "json" };
import { listResources, readResource } from "./resources.ts";
import { callTool, TOOLS } from "./tools.ts";

/** Newest first; the server answers with the client's version when it knows it, else the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Id = string | number;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: Id | null;
  method: string;
  params?: Record<string, unknown>;
}
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: Id | null; result: unknown }
  | { jsonrpc: "2.0"; id: Id | null; error: { code: number; message: string; data?: unknown } };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const RESOURCE_NOT_FOUND = -32002;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const INSTRUCTIONS = `Renox local platform server for the project in the folder \`renox mcp\` was started in.
Read docs://00-overview.md first, docs://07-app-model.md for routes, loaders and actions, and types://renox/ctx.d.ts for the ctx API.
Use run_check after editing, dev_errors when \`renox dev\` reports a failure, and search_docs to find a rule.`;

export interface Server {
  /** Handles one parsed message; null for a notification (nothing to send). */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
}

export function createServer(project: string): Server {
  let initialized = false;

  const dispatch = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
        initialized = true;
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          serverInfo: { name: "renox", title: "Renox (local)", version: pkg.version },
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call": {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== "string") throw new RpcError(INVALID_PARAMS, "tools/call: name must be a string");
        if (typeof args !== "object" || args === null || Array.isArray(args))
          throw new RpcError(INVALID_PARAMS, "tools/call: arguments must be an object");
        const result = await callTool(name, args as Record<string, unknown>, project);
        if (!result) throw new RpcError(INVALID_PARAMS, `unknown tool: ${name}`);
        return result;
      }
      case "resources/list":
        return { resources: listResources() };
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string") throw new RpcError(INVALID_PARAMS, "resources/read: uri must be a string");
        const contents = readResource(uri, project);
        if (!contents) throw new RpcError(RESOURCE_NOT_FOUND, "resource not found", { uri });
        return { contents: [contents] };
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  };

  return {
    async handle(message) {
      const m = message as Partial<JsonRpcRequest> | null;
      const isObject = typeof m === "object" && m !== null && !Array.isArray(m);
      const id = isObject && (typeof m.id === "string" || typeof m.id === "number") ? m.id : null;
      if (!isObject || m.jsonrpc !== "2.0" || typeof m.method !== "string")
        return { jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "invalid JSON-RPC 2.0 request" } };
      // Notifications (initialized, cancelled, ...) get no answer.
      if (!("id" in m) || m.id === undefined) return null;
      if (m.method !== "initialize" && m.method !== "ping" && !initialized)
        return { jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "the server is not initialized: send initialize first" } };
      const params = m.params ?? {};
      if (typeof params !== "object" || Array.isArray(params))
        return { jsonrpc: "2.0", id, error: { code: INVALID_PARAMS, message: "params must be an object" } };
      try {
        return { jsonrpc: "2.0", id, result: await dispatch(m.method, params) };
      } catch (e) {
        if (e instanceof RpcError)
          return { jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } };
        return { jsonrpc: "2.0", id, error: { code: -32603, message: `internal error: ${(e as Error).message}` } };
      }
    },
  };
}

/** Serves `server` on stdin/stdout until stdin closes. */
export async function serveStdio(server: Server, input: ReadableStream<Uint8Array>, write: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const pending = new Set<Promise<void>>();
  let buf = "";
  const onLine = (line: string): void => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } }));
      return;
    }
    const p = server.handle(message).then((r) => {
      if (r) write(JSON.stringify(r));
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  for await (const chunk of input) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/u, ""));
      buf = buf.slice(i + 1);
    }
  }
  onLine(buf);
  await Promise.all(pending);
}
