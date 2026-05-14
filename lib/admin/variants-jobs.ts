/**
 * In-memory registry for variant-rebuild jobs.
 *
 * Single-active-job invariant: while one job is running, additional
 * tryStartJob calls fold and return the existing jobId. The operator
 * waits for it to finish, then starts the next one.
 *
 * State is process-local and ephemeral. On process restart, in-flight
 * jobs are forgotten (admin re-clicks). The trade-off: simpler than
 * persisted job state, acceptable because rebuild is idempotent and rare.
 *
 * Stashed on globalThis for Next.js HMR / hot-reload survival (same
 * pattern as lib/sse-broadcast.ts).
 */

import { randomUUID } from "node:crypto";

export type JobScope = "user" | "all";

export interface JobError {
  generationId: number;
  reason: string;
  error?: string;
}

export interface JobState {
  jobId: string;
  scope: JobScope;
  userId?: number;
  startedAt: string;
  total: number;
  done: number;
  currentEmail?: string;
  errors: JobError[];
  finished: boolean;
  finishedAt?: string;
}

interface Registry {
  byId: Map<string, JobState>;
  activeId: string | null;
}

const ERROR_CAP = 100;

const g = globalThis as unknown as { __variantsJobs?: Registry };
const registry: Registry =
  g.__variantsJobs ?? { byId: new Map(), activeId: null };
g.__variantsJobs = registry;

export type StartResult =
  | { started: true; jobId: string }
  | { started: false; existingJobId: string };

export function tryStartJob(input: {
  scope: JobScope;
  userId?: number;
  total: number;
}): StartResult {
  if (registry.activeId) {
    return { started: false, existingJobId: registry.activeId };
  }
  const jobId = randomUUID();
  const state: JobState = {
    jobId,
    scope: input.scope,
    userId: input.userId,
    startedAt: new Date().toISOString(),
    total: input.total,
    done: 0,
    errors: [],
    finished: false,
  };
  registry.byId.set(jobId, state);
  registry.activeId = jobId;
  return { started: true, jobId };
}

export function bumpDone(jobId: string, currentEmail?: string): void {
  const s = registry.byId.get(jobId);
  if (!s) return;
  s.done += 1;
  if (currentEmail !== undefined) s.currentEmail = currentEmail;
}

export function appendError(jobId: string, err: JobError): void {
  const s = registry.byId.get(jobId);
  if (!s) return;
  if (s.errors.length >= ERROR_CAP) return;
  s.errors.push(err);
}

export function finishJob(jobId: string): void {
  const s = registry.byId.get(jobId);
  if (!s) return;
  s.finished = true;
  s.finishedAt = new Date().toISOString();
  if (registry.activeId === jobId) registry.activeId = null;
}

export function getJob(jobId: string): JobState | null {
  return registry.byId.get(jobId) ?? null;
}

export function getActiveJob(): JobState | null {
  if (!registry.activeId) return null;
  return registry.byId.get(registry.activeId) ?? null;
}

/** Test-only — resets the registry between tests. */
export function _resetForTests(): void {
  registry.byId.clear();
  registry.activeId = null;
}
