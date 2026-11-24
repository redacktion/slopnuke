import assert from "node:assert/strict";
import { test } from "node:test";
import { contractMessage, type ContractScope } from "./contract.ts";

test("contractMessage: SlopSift messages per scope -> the original diagnosis with contract advice", () => {
  const cases: [string, string, ContractScope, string][] = [
    [
      "ai-style/comma-splice",
      "Comma splice: two independent clauses are joined only by a comma. Subordinate one clause, or use a conjunction, semicolon, dash, or full stop.",
      "prose",
      "Comma splice: two independent clauses are joined only by a comma. Join the clauses with and or but, with because or so where one causes the other, or end the first sentence with a period.",
    ],
    [
      "ai-style/agentless-opener",
      "Agentless opener: a verbless fragment (“Notes attached, and it …”) that circles back with a pronoun. Name the doer — “I’ve attached the notes — a fuller record than the summary.”",
      "prose",
      "Agentless opener: a verbless fragment (“Notes attached, and it …”) that circles back with a pronoun. Make the program or person that acts the subject of the opening clause.",
    ],
    [
      "reader-first/fragment-chain",
      "3 nearby sentences are compressed fragments. Name the subject and state the action in each sentence.",
      "comments",
      '3 nearby sentences are compressed fragments. Write a noun phrase that names the thing and the program that uses it ("Setting value type that the CLI uses for parsing, TOML validation and the config editor."), a condition or a copula sentence.',
    ],
    ["reader-first/noun-pile", "4 nouns are stacked around “directories”. Add a verb or preposition to show how the ideas relate.", "prose", "4 nouns are stacked around “directories”. Add a verb or preposition to show how the ideas relate."],
  ];
  assert.deepEqual(
    cases.map(([ruleId, message, scope]) => contractMessage(ruleId, message, scope)),
    cases.map(([, , , expected]) => expected),
  );
});
