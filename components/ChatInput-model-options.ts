import { formatCompactNumber } from "@/lib/format";

export interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

/** Both catalog shapes must keep provider identity and apply the same visibility. */
export function buildModelOptions(
  modelList: Array<{ provider: string; id: string; name: string }> | undefined,
  modelNames: Record<string, string> | undefined,
  currentProvider: string | undefined,
  visibleModelKeys: ReadonlySet<string> | null,
  collator: Intl.Collator,
): ModelOption[] {
  const options = modelList?.length
    ? modelList.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }))
    : Object.entries(modelNames ?? {}).map(([key, name]) => {
      const separator = key.indexOf(":");
      return separator > 0
        ? { provider: key.slice(0, separator), modelId: key.slice(separator + 1), name }
        : { provider: currentProvider ?? "unknown", modelId: key, name };
    });
  return options
    .filter((option) => visibleModelKeys === null || visibleModelKeys.has(`${option.provider}:${option.modelId}`))
    .sort((a, b) => compareModelOptions(collator, a, b));
}

export function compareModelOptions(collator: Intl.Collator, a: ModelOption, b: ModelOption): number {
  return collator.compare(a.name || a.modelId, b.name || b.modelId)
    || collator.compare(a.provider, b.provider)
    || collator.compare(a.modelId, b.modelId);
}

export function formatTokenCount(tokens: number, locale: string): string {
  return formatCompactNumber(tokens, locale);
}
