import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAccept, type ShownFinding } from "./accept.ts";
import { parseReviewAnswer, reviewForm, selectItems } from "./review.ts";

const GPU: ShownFinding = { id: "aaaaaaaaaa", ruleId: "reader-first/unexplained-initialism", text: "GPU", place: "PROTOCOL.md:3", message: "Spell out GPU.", count: 2 };
const PARTICIPLE: ShownFinding = { id: "bbbbbbbbbb", ruleId: "slopnuke/participle-after-noun", text: "led by a descendant", place: "PROTOCOL.md:22", message: "Participle phrase.", count: 1 };
const LONG: ShownFinding = { id: "cccccccccc", ruleId: "reader-first/fragment-chain", text: "word ".repeat(40), place: "PROTOCOL.md:40", message: "Fragments.", count: 1 };
const BLANK: ShownFinding = { id: "dddddddddd", ruleId: "ai-style/em-dash-overuse", text: "   ", place: "PROTOCOL.md:50", message: "Dash.", count: 1 };

test("parseReviewAnswer: elicitation responses -> accept entries or no write", () => {
  const items = [GPU, PARTICIPLE];
  const cases: [ShownFinding[], unknown, unknown][] = [
    [items, { action: "accept", content: { aaaaaaaaaa: "Accept text", bbbbbbbbbb: "Rewrite finding" } }, { kind: "answered", entries: [{ ruleId: GPU.ruleId, text: "GPU" }], rewrite: [PARTICIPLE] }],
    [items, { action: "accept", content: { aaaaaaaaaa: "Accept rule for repo" } }, { kind: "answered", entries: [{ ruleId: GPU.ruleId, text: null }], rewrite: [PARTICIPLE] }],
    [items, { action: "accept", content: {} }, { kind: "answered", entries: [], rewrite: [GPU, PARTICIPLE] }],
    [items, { action: "accept", content: { aaaaaaaaaa: "Accept everything" } }, { kind: "invalid", reason: "the answer for aaaaaaaaaa is not one of Rewrite finding, Accept text, Accept rule for repo" }],
    [[LONG], { action: "accept", content: { cccccccccc: "Accept text" } }, { kind: "invalid", reason: "the answer for cccccccccc is not one of Rewrite finding, Accept rule for repo" }],
    [[BLANK], { action: "accept", content: { dddddddddd: "Accept text" } }, { kind: "invalid", reason: "the answer for dddddddddd is not one of Rewrite finding, Accept rule for repo" }],
    [items, { action: "accept" }, { kind: "invalid", reason: "the accepted response has no form content" }],
    [items, { action: "decline" }, { kind: "declined" }],
    [items, { action: "cancel" }, { kind: "cancelled" }],
    [items, null, { kind: "invalid", reason: "the response has no accept, decline or cancel action" }],
  ];
  assert.deepEqual(
    cases.map(([list, response]) => parseReviewAnswer(list, response)),
    cases.map(([, , expected]) => expected),
  );
});

test("reviewForm: short and long findings -> flat string enums, repo in message, default on request", () => {
  assert.deepEqual([reviewForm([GPU, LONG], "/r", true), reviewForm([GPU], "/r", false).requestedSchema.properties.aaaaaaaaaa], [
    {
      message: "slopnuke findings in /r",
      requestedSchema: {
        type: "object",
        properties: {
          aaaaaaaaaa: {
            type: "string",
            title: "PROTOCOL.md:3 reader-first/unexplained-initialism, 2 places",
            description: "Spell out GPU. Text: GPU",
            enum: ["Rewrite finding", "Accept text", "Accept rule for repo"],
            default: "Rewrite finding",
          },
          cccccccccc: {
            type: "string",
            title: "PROTOCOL.md:40 reader-first/fragment-chain",
            description: `Fragments. Text, first part: ${"word ".repeat(31)}wo...`,
            enum: ["Rewrite finding", "Accept rule for repo"],
            default: "Rewrite finding",
          },
        },
      },
    },
    {
      type: "string",
      title: "PROTOCOL.md:3 reader-first/unexplained-initialism, 2 places",
      description: "Spell out GPU. Text: GPU",
      enum: ["Rewrite finding", "Accept text", "Accept rule for repo"],
    },
  ]);
});

test("selectItems: requested ids -> open items, unknown ids, overflow ids", () => {
  const many = new Map<string, ShownFinding>(Array.from({ length: 12 }, (_, index) => {
    const id = String(index).padStart(10, "0");
    return [id, { ...PARTICIPLE, id, text: `text ${index}` }];
  }));
  const shown = new Map([[GPU.id, GPU], [PARTICIPLE.id, PARTICIPLE]]);
  const none = parseAccept("");
  const cases: [Map<string, ShownFinding>, string[] | undefined, string, { items: number; unknown: string[]; rest: string[] }][] = [
    [shown, undefined, "", { items: 2, unknown: [], rest: [] }],
    [shown, ["bbbbbbbbbb", "bbbbbbbbbb"], "", { items: 1, unknown: [], rest: [] }],
    [shown, ["eeeeeeeeee", "aaaaaaaaaa"], "", { items: 1, unknown: ["eeeeeeeeee"], rest: [] }],
    [shown, undefined, "reader-first/unexplained-initialism GPU", { items: 1, unknown: [], rest: [] }],
    [many, undefined, "", { items: 10, unknown: [], rest: ["0000000010", "0000000011"] }],
    [many, undefined, "slopnuke/participle-after-noun text 0", { items: 10, unknown: [], rest: ["0000000011"] }],
  ];
  assert.deepEqual(
    cases.map(([map, ids, accepted]) => {
      const selection = selectItems(map, ids, accepted === "" ? none : parseAccept(accepted));
      return { items: selection.items.length, unknown: selection.unknown, rest: selection.rest };
    }),
    cases.map(([, , , expected]) => expected),
  );
});
