/** @vitest-environment node */
import { describe, it, expect, beforeEach } from "vitest";
import {
  tryStartJob,
  appendError,
  bumpDone,
  finishJob,
  getJob,
  getActiveJob,
  _resetForTests,
} from "../variants-jobs";

beforeEach(() => {
  _resetForTests();
});

describe("variants-jobs", () => {
  it("tryStartJob returns a fresh jobId when nothing is running", () => {
    const r = tryStartJob({ scope: "user", userId: 5, total: 10 });
    expect(r.started).toBe(true);
    if (r.started) {
      expect(typeof r.jobId).toBe("string");
      expect(r.jobId.length).toBeGreaterThan(8);
    }
  });

  it("tryStartJob folds — returns existing job when one is running", () => {
    const r1 = tryStartJob({ scope: "user", userId: 5, total: 10 });
    expect(r1.started).toBe(true);
    const r2 = tryStartJob({ scope: "all", total: 100 });
    expect(r2.started).toBe(false);
    if (r1.started && !r2.started) {
      expect(r2.existingJobId).toBe(r1.jobId);
    }
  });

  it("after finishJob, a new start succeeds", () => {
    const r1 = tryStartJob({ scope: "user", userId: 5, total: 10 });
    if (!r1.started) throw new Error("expected started");
    finishJob(r1.jobId);
    const r2 = tryStartJob({ scope: "all", total: 100 });
    expect(r2.started).toBe(true);
  });

  it("bumpDone increments and getJob reflects state", () => {
    const r = tryStartJob({ scope: "user", userId: 5, total: 3 });
    if (!r.started) throw new Error("expected started");
    bumpDone(r.jobId);
    bumpDone(r.jobId);
    const job = getJob(r.jobId);
    expect(job?.done).toBe(2);
    expect(job?.total).toBe(3);
    expect(job?.finished).toBe(false);
  });

  it("appendError caps at 100 entries", () => {
    const r = tryStartJob({ scope: "all", total: 200 });
    if (!r.started) throw new Error("expected started");
    for (let i = 0; i < 150; i++) {
      appendError(r.jobId, { generationId: i, reason: "decode_failed" });
    }
    expect(getJob(r.jobId)?.errors.length).toBe(100);
  });

  it("getActiveJob returns the running job or null", () => {
    expect(getActiveJob()).toBeNull();
    const r = tryStartJob({ scope: "user", userId: 5, total: 1 });
    if (!r.started) throw new Error("expected started");
    expect(getActiveJob()?.jobId).toBe(r.jobId);
    finishJob(r.jobId);
    expect(getActiveJob()).toBeNull();
  });
});
