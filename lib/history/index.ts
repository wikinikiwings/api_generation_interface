// Public API for the history module. Anything not re-exported here is
// considered private and may not be imported from outside lib/history.

export { useHistoryEntries, useEntryById } from "@/lib/history/hooks";
export { useGenerationEvents } from "@/lib/history/sse";
export {
  deleteEntry,
  addPendingEntry,
  updatePendingEntry,
  confirmPendingEntry,
  markPendingError,
  setPendingControls,
  getPendingControls,
} from "@/lib/history/mutations";

export type {
  HistoryEntry,
  EntryState,
  DateRange,
  NewPendingInput,
  ServerGeneration,
  ServerOutput,
} from "@/lib/history/types";
