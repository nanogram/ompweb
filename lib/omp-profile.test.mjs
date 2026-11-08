import assert from "node:assert/strict";
import test from "node:test";
import { isValidOmpProfile } from "./omp-profile.ts";

test("profile names follow omp's portable directory rule", () => {
  for (const name of ["", "work", "9lives", "a".repeat(64), "team.config_v2-2026", "console", "com1x"]) assert.equal(isValidOmpProfile(name), true, name);
  for (const name of ["bad profile", "Nova", "工作", "-lead", ".hidden", "trailing.", "a".repeat(65), "con", "con.txt", "aux.settings", "nul", "com0", "com9", "lpt0", "lpt9"]) assert.equal(isValidOmpProfile(name), false, name);
});
