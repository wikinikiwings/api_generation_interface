"use client";

// Stub for Task 7. Real BroadcastChannel impl replaces this in the next
// commit; mutations.ts depends on `broadcast.post(...)` shape.
type StubMessage = { type: string; [key: string]: unknown };

export const broadcast = {
  post(_msg: StubMessage): void {
    /* stub */
  },
};
