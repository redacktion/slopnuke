import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./slopnuke.ts", import.meta.url));
const SLOP = "This guide meticulously delves into the myriad of options to seamlessly leverage them.\n";
const base = realpathSync(tmpdir());
const created: string[] = [];
let counter = 0;

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// Fixture repo with one open md round and a filled shown file.
function fixture(): { repo: string; home: string; ids: string[] } {
  const dir = join(base, `slopnuke-mcp-test-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  created.push(dir);
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "notes.md"), `# Notes\n\n${SLOP}`);
  const started = spawnSync(process.execPath, [CLI, "start", "md"], { cwd: repo, encoding: "utf8", env: { ...process.env, SLOPNUKE_HOME: home } });
  const ids = [...new Set([...started.stdout.matchAll(/\[([0-9a-f]{10})\]$/gm)].map((match) => match[1]))];
  assert.ok(ids.length >= 2, started.stdout);
  return { repo, home, ids };
}

interface Session {
  raw(line: string): void;
  call(args: object): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

// Scripted MCP client over the server stdio with a fixed answer for each elicitation request.
async function connect(home: string, capabilities: object, answer: (params: any) => unknown): Promise<Session> {
  const child = spawn(process.execPath, [CLI, "mcp"], { env: { ...process.env, SLOPNUKE_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, (message: any) => void>();
  let next = 0;
  const send = (message: object): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "elicitation/create") {
      send({ jsonrpc: "2.0", id: message.id, result: answer(message.params) });
      return;
    }
    if (message.id !== null) waiting.get(message.id)?.(message);
  });
  const request = (method: string, params: object): Promise<any> =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    raw(line) {
      child.stdin.write(`${line}\n`);
    },
    async call(args) {
      const reply = await request("tools/call", { name: "review", arguments: args });
      return { text: reply.result.content[0].text, isError: reply.result.isError };
    },
    close() {
      return new Promise((done) => {
        child.on("close", () => done());
        child.stdin.end();
      });
    },
  };
}

const acceptLines = (repo: string): string[] => {
  const file = join(repo, ".slopnuke-accept");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line && !line.startsWith("#")) : [];
};

test("mcp review: accepted form with one Accept text -> one accept line, other findings to rewrite", async () => {
  const fx = fixture();
  let form: any;
  const session = await connect(fx.home, { elicitation: { form: {} } }, (params) => {
    form = params;
    return { action: "accept", content: { [fx.ids[0]]: "Accept text" } };
  });
  const result = await session.call({ repo: fx.repo });
  await session.close();
  assert.equal(form.mode, "form");
  assert.deepEqual(Object.keys(form.requestedSchema.properties).sort(), [...fx.ids].sort());
  assert.equal(result.isError, false);
  assert.match(result.text, /accepted \S+ /);
  assert.match(result.text, new RegExp(`\\[${fx.ids[1]}\\]`));
  assert.equal(acceptLines(fx.repo).length, 1);
});

test("mcp review: decline, cancel, bad enum value, null line, no capability, unknown id, relative repo -> no write to the accept file", async () => {
  const fx = fixture();
  const outcomes: { text: string; isError: boolean }[] = [];
  for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { [fx.ids[0]]: "Accept everything" } }]) {
    const session = await connect(fx.home, { elicitation: {} }, () => answer);
    outcomes.push(await session.call({ repo: fx.repo }));
    await session.close();
  }
  const plain = await connect(fx.home, {}, () => assert.fail("no elicitation without the capability"));
  plain.raw("null");
  outcomes.push(await plain.call({ repo: fx.repo }));
  outcomes.push(await plain.call({ repo: fx.repo, ids: ["0000000000"] }));
  outcomes.push(await plain.call({ repo: "relative/path" }));
  await plain.close();
  assert.deepEqual(
    outcomes.map((outcome) => outcome.isError),
    [false, false, true, false, true, true],
  );
  assert.match(outcomes[3].text, /no form support[\s\S]*accept <id>/);
  assert.deepEqual(acceptLines(fx.repo), []);
});
