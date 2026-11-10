/** The picker uses provider-qualified keys, not omp's enabledModels allowlist. */
export type ComposerModelKeys = string[] | null;

export const COMPOSER_MODELS_STORAGE_KEY = "omp-composer-models";
export const COMPOSER_MODELS_CHANGED_EVENT = "omp-composer-models-change";

export function isComposerModelKeys(value: unknown): value is ComposerModelKeys {
  return value === null || (Array.isArray(value) && value.every((key) => (
    typeof key === "string" && key.indexOf(":") > 0 && key.indexOf(":") < key.length - 1
  )));
}
