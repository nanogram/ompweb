import assert from "node:assert/strict";
import test from "node:test";
import { branchPreviewForEntry, projectTreeForResponse } from "./session-tree.ts";

const node = (id, text = id, label) => ({
  entry: { type: "message", id, message: { role: "user", content: text } },
  children: [], ...(label ? { label } : {}),
});

test("navigation contracts long chains while preserving labeled nodes and branch preview identity", () => {
  const nodes = Array.from({ length: 1000 }, (_, index) => node(`row-${index}`, index === 1 ? "  First\n branch request  " : `body ${index}`, index === 500 ? "important" : undefined));
  for (let index = 1; index < nodes.length; index++) nodes[index - 1].children.push(nodes[index]);
  const tree = projectTreeForResponse([nodes[0]]);
  assert.equal(tree[0].entry.id, "row-0");
  const labeled = tree[0].children[0];
  assert.equal(labeled.entry.id, "row-500");
  assert.equal(labeled.label, "important");
  assert.equal(labeled.compressedEntryIds.length, 499);
  assert.equal(labeled.branchPreview.text, "First branch request");
  assert.equal(labeled.children[0].entry.id, "row-999");
  assert.equal(labeled.children[0].compressedEntryIds.length, 498);
  assert.equal(nodes[0].children[0], nodes[1], "response projection never mutates the canonical topology");
});

test("deep branching navigation is projected iteratively and remains shallow", () => {
  const root = node("root");
  let current = root;
  for (let index = 0; index < 1200; index++) {
    const next = node(`branch-${index}`);
    current.children.push(node(`sibling-${index}`), next);
    current = next;
  }
  const result = projectTreeForResponse([root]);
  const pending = result.map(node => ({ node, depth: 1 }));
  const ids = new Set();
  let maxDepth = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    ids.add(node.entry.id);
    maxDepth = Math.max(maxDepth, depth);
    for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
  }
  assert.equal(ids.size, 2401);
  assert.ok(maxDepth <= 201);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("branch previews retain short user/assistant labels without retaining large bodies", () => {
  assert.deepEqual(branchPreviewForEntry(node("a", "  whitespace\n normalized ").entry), { role: "user", text: "whitespace normalized" });
  const entry = { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "x".repeat(1000) }] } };
  const preview = branchPreviewForEntry(entry);
  assert.equal(preview.role, "assistant");
  assert.equal(preview.text.length, 41);
  assert.equal(preview.text, "x".repeat(40) + "…");
  assert.equal(branchPreviewForEntry({ type: "model_change" }), undefined);
});
