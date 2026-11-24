import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { runReview, type ReviewForm } from "../core/review.ts";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-11-25"];
const LATEST_PROTOCOL = "2025-11-25";
const TOOL_NAME = "review";

interface Message {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: unknown;
  error?: { code: number; message: string };
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const TOOL = {
  name: TOOL_NAME,
  title: "slopnuke review",
  description:
    "Ask the user to decide each slopnuke finding from the last round: rewrite it, accept the flagged text, or accept the whole rule for the repo. Call it for findings that are correct as written, then rewrite the rest and run the slopnuke next command.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Absolute path of the repo of the slopnuke run, or of a folder inside it" },
      ids: { type: "array", items: { type: "string" }, description: "Finding ids from the last round, without brackets. All findings of the last round when absent, up to 10." },
    },
    required: ["repo"],
  },
};

// Elicitation support test in which slopnuke reads an empty capability object as form support.
function formCapable(capabilities: any): boolean {
  const elicitation = capabilities?.elicitation;
  if (elicitation === null || typeof elicitation !== "object") return false;
  return !("url" in elicitation || "form" in elicitation) || "form" in elicitation;
}

// Newline-delimited JSON-RPC server for the slopnuke review tool.
export function serveMcp(input: Readable, output: Writable, version: string, acceptCommand: string): Promise<void> {
  const pending = new Map<string, Pending>();
  let canElicit = false;
  let protocol = LATEST_PROTOCOL;
  let counter = 0;

  const cancelled = new Set<string>();
  output.on("error", () => {});
  const send = (message: Message): void => {
    if (message.method === undefined && message.id !== undefined && message.id !== null && cancelled.delete(String(message.id))) return;
    if (!output.writableEnded) output.write(`${JSON.stringify(message)}\n`);
  };

  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = `slopnuke-${++counter}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const elicit = async (form: ReviewForm): Promise<unknown> => request("elicitation/create", protocol === "2025-06-18" ? form : { mode: "form", ...form });

  async function handle(message: Message): Promise<void> {
    const { id, method, params } = message;
    const reply = (result: unknown): void => send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string): void => send({ jsonrpc: "2.0", id, error: { code, message: text } });
    switch (method) {
      case "initialize": {
        canElicit = formCapable(params?.capabilities);
        const asked = params?.protocolVersion;
        protocol = SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL;
        reply({
          protocolVersion: protocol,
          capabilities: { tools: {} },
          serverInfo: { name: "slopnuke", version },
        });
        return;
      }
      case "ping":
        reply({});
        return;
      case "tools/list":
        reply({ tools: [TOOL] });
        return;
      case "tools/call": {
        if (params?.name !== TOOL_NAME) {
          fail(-32602, `unknown tool ${String(params?.name)}`);
          return;
        }
        const args = params?.arguments ?? {};
        const ids = Array.isArray(args.ids) ? args.ids.filter((value: unknown): value is string => typeof value === "string") : undefined;
        try {
          const result = await runReview(args.repo, ids, { ask: canElicit ? elicit : null, defaults: protocol !== "2025-06-18", acceptCommand });
          reply({ content: [{ type: "text", text: result.text }], isError: result.error });
        } catch (error) {
          reply({ content: [{ type: "text", text: `slopnuke review failed: ${(error as Error).message}` }], isError: true });
        }
        return;
      }
      default:
        if (id !== undefined) fail(-32601, `method not found: ${String(method)}`);
    }
  }

  return new Promise((done) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
        return;
      }
      if (message.method === undefined && message.id !== undefined && message.id !== null) {
        const waiter = pending.get(String(message.id));
        if (!waiter) return;
        pending.delete(String(message.id));
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method !== undefined && message.id === undefined) {
        const requestId = message.params?.requestId;
        if (message.method === "notifications/cancelled" && (typeof requestId === "string" || typeof requestId === "number")) cancelled.add(String(requestId));
        return;
      }
      void handle(message);
    });
    lines.on("close", () => {
      for (const waiter of pending.values()) waiter.reject(new Error("the client closed the connection"));
      pending.clear();
      done();
    });
  });
}
