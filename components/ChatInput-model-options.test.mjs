import assert from "node:assert/strict";
import test from "node:test";
import { buildModelOptions } from "./ChatInput-model-options.ts";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const catalog = [
  { provider: "provider-a", id: "shared:model", name: "First model" },
  { provider: "provider-b", id: "shared:model", name: "Second model" },
  { provider: "provider-a", id: "other", name: "Other model" },
];
const names = Object.fromEntries(catalog.map((model) => [`${model.provider}:${model.id}`, model.name]));

test("both modelList and modelNames preserve provider/model identity and exclude every unselected option", () => {
  for (const list of [catalog, [], undefined]) {
    const options = buildModelOptions(list, names, "wrong-provider", new Set(["provider-b:shared:model"]), collator);
    assert.deepEqual(options, [{ provider: "provider-b", modelId: "shared:model", name: "Second model" }]);
  }
});

test("explicit all and none apply to both catalog paths, without synthesizing selected models", () => {
  for (const list of [catalog, [], undefined]) {
    assert.equal(buildModelOptions(list, names, undefined, null, collator).length, 3);
    assert.deepEqual(buildModelOptions(list, names, undefined, new Set(), collator), []);
    assert.deepEqual(buildModelOptions(list, names, undefined, new Set(["missing:model"]), collator), []);
  }
});

test("legacy bare modelNames use only the known current provider, never another provider's selected identity", () => {
  const bare = { shared: "Shared model" };
  assert.deepEqual(buildModelOptions(undefined, bare, "provider-a", new Set(["provider-b:shared"]), collator), []);
  assert.deepEqual(buildModelOptions(undefined, bare, "provider-a", new Set(["provider-a:shared"]), collator), [
    { provider: "provider-a", modelId: "shared", name: "Shared model" },
  ]);
  assert.deepEqual(buildModelOptions(undefined, bare, undefined, new Set(["provider-a:shared"]), collator), []);
});
