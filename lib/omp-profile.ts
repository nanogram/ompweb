const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Mirrors omp's portable profile-directory naming rule. Empty means no selection in a form. */
export function isValidOmpProfile(name: string): boolean {
  return name === "" || (PROFILE_NAME_PATTERN.test(name)
    && !name.endsWith(".") && !WINDOWS_RESERVED_BASE.test(name.split(".")[0]));
}
