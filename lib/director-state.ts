import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { comparableProjectPath } from "./comparable-path";
import { getAgentDir } from "./omp/paths";
import { isValidSessionId } from "./session-file-references-core";
import { DEFAULT_DIRECTOR_CONFIG, DirectorError, directorDay, parseDirectorPatch, type DirectorDaily } from "./director-engine";
import type { DirectorConfig } from "./director-types";
import type { SessionInfo } from "./types";

export const getDirectorDir = () => join(getAgentDir(), "omp-web", "director");
export const getDirectorWorkspaceCwd = () => join(getDirectorDir(), "workspace");
export const getDirectorStatePath = () => join(getDirectorDir(), "state.json");
export const isDirectorWorkspace = (cwd: string) => comparableProjectPath(cwd) === comparableProjectPath(getDirectorWorkspaceCwd());

export interface DirectorPersistentState {
  version: 1;
  config: DirectorConfig;
  session: SessionInfo | null;
  /** Written BEFORE a fresh host spawn. An unresolved reservation never spawns again. */
  creating: boolean;
  bootstrapReviewed: boolean;
  reviewed: Record<string, string>;
  lastReviewAt: number | null;
  daily: DirectorDaily;
  /** At-most-once send reservation survives ACK loss and web restart. */
  inFlight: { id: string; startedAt: number; phase: "reserved" | "accepted" | "uncertain"; runStarted: boolean; terminalObserved: boolean } | null;
  reviewRequest: string | null;
  lastError: string | null;
  nextReviewAt: number | null;
}

export function newDirectorState(now = Date.now()): DirectorPersistentState {
  return {
    version: 1,
    config: { ...DEFAULT_DIRECTOR_CONFIG, watchedProjects: [] },
    session: null, creating: false, bootstrapReviewed: false, reviewed: {}, lastReviewAt: null,
    daily: { date: directorDay(now), reviews: 0, baseline: null, lastTotal: null, costUsd: null },
    inFlight: null, reviewRequest: null, lastError: null, nextReviewAt: null,
  };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nullableNumber = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

export function parseDirectorState(raw: string): DirectorPersistentState {
  try {
    const data: unknown = JSON.parse(raw);
    if (!object(data) || data.version !== 1 || !object(data.config)) throw new Error();
    // Existing observe-only installations retain that permission until explicitly enabled.
    const configInput: Record<string, unknown> = { controlEnabled: false, ...data.config };
    // Retire the old spending/review caps without discarding the chat or review ledger.
    delete configInput.dailyBudgetUsd;
    delete configInput.maxReviewsPerDay;
    if (Object.keys(DEFAULT_DIRECTOR_CONFIG).some((key) => !Object.hasOwn(configInput, key))) throw new Error();
    const config = parseDirectorPatch(configInput);
    if (!object(data.daily) || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.daily.date)) || !Number.isSafeInteger(data.daily.reviews) || (data.daily.reviews as number) < 0
      || !nullableNumber(data.daily.baseline) || !nullableNumber(data.daily.lastTotal) || !nullableNumber(data.daily.costUsd)) throw new Error();
    if (data.session !== null && (!object(data.session) || !isValidSessionId(data.session.id as string) || typeof data.session.path !== "string" || !data.session.path || typeof data.session.cwd !== "string" || !isDirectorWorkspace(data.session.cwd) || data.session.hostId !== "local"
      || typeof data.session.created !== "string" || typeof data.session.modified !== "string" || typeof data.session.firstMessage !== "string" || typeof data.session.messageCount !== "number")) throw new Error();
    if (typeof data.creating !== "boolean" || typeof data.bootstrapReviewed !== "boolean" || !object(data.reviewed) || Object.keys(data.reviewed).length > 256
      || Object.entries(data.reviewed).some(([key, value]) => key.length > 256 || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      || !nullableNumber(data.lastReviewAt) || !nullableNumber(data.nextReviewAt) || (data.reviewRequest !== null && (typeof data.reviewRequest !== "string" || data.reviewRequest.length > 128))
      || (data.lastError !== null && (typeof data.lastError !== "string" || data.lastError.length > 2000))) throw new Error();
    if (data.inFlight !== null && (!object(data.inFlight) || typeof data.inFlight.id !== "string" || data.inFlight.id.length > 128 || !nullableNumber(data.inFlight.startedAt) || data.inFlight.startedAt === null
      || (data.inFlight.phase !== "reserved" && data.inFlight.phase !== "accepted" && data.inFlight.phase !== "uncertain") || typeof data.inFlight.runStarted !== "boolean" || typeof data.inFlight.terminalObserved !== "boolean")) throw new Error();
    return { ...data, config } as unknown as DirectorPersistentState;
  } catch {
    throw new DirectorError("Director state is unreadable or corrupt; preserved without creating another chat", "director_state_corrupt");
  }
}

export function readDirectorState(): DirectorPersistentState {
  try {
    const path = getDirectorStatePath();
    if (lstatSync(path).size > 1_048_576) throw new DirectorError("Director state exceeds its private size limit", "director_state_corrupt");
    return parseDirectorState(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return newDirectorState();
    if (error instanceof DirectorError) throw error;
    throw new DirectorError("Director state cannot be read; preserved without creating another chat", "director_state_corrupt");
  }
}

/** Enforcement cannot make unrelated sessions unusable when private state is damaged. */
export function isDirectorSession(sessionId: string, cwd?: string): boolean {
  if (cwd !== undefined) return isDirectorWorkspace(cwd);
  try { return readDirectorState().session?.id === sessionId; } catch { return false; }
}

function ownerExited(text: string): boolean {
  try {
    const owner = JSON.parse(text);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return false; }
}

/** Publish a complete PID lock atomically, and recover only a proven-dead PID.
 * A second recovery lock serializes unlink against a faster successor. */
export function acquireDirectorLock(name = "owner.lock"): (() => void) | null {
  const dir = getDirectorDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, name);
  const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const temp = `${lock}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, token, { mode: 0o600, flag: "wx" });
  try {
    try { linkSync(temp, lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let text: string;
      try { text = readFileSync(lock, "utf8"); } catch { return null; }
      if (!ownerExited(text)) return null;
      const recovery = acquireDirectorLock(`${name}.recover`);
      if (!recovery) return null;
      try {
        if (readFileSync(lock, "utf8") !== text) return null;
        unlinkSync(lock);
        linkSync(temp, lock);
      } finally { recovery(); }
    }
  } finally { unlinkSync(temp); }
  return () => {
    try { if (readFileSync(lock, "utf8") === token) unlinkSync(lock); } catch { /* No longer ours. */ }
  };
}

export function mutateDirectorState(update: (state: DirectorPersistentState) => void): DirectorPersistentState {
  const release = acquireDirectorLock("state.lock");
  if (!release) throw new DirectorError("Director state is being updated; retry the request", "director_state_busy");
  const path = getDirectorStatePath();
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const state = readDirectorState();
    const before = JSON.stringify(state);
    update(state);
    if (JSON.stringify(state) === before) return state;
    const text = `${JSON.stringify(state)}\n`;
    // Validate what we publish too: a failed mutation cannot poison identity.
    parseDirectorState(text);
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    return state;
  } finally {
    try { unlinkSync(temp); } catch { /* Renamed or never opened. */ }
    release();
  }
}

export function writeDirectorPrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch { /* Renamed. */ } }
}
