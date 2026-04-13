"use client";

import { deleteEntry } from "@/lib/history/mutations";
import { hydrateFromServer } from "@/lib/history/hydrate";
import { debugHistory } from "@/lib/history/debug";

type BroadcastMessage =
  | { type: "delete"; id: string; serverGenId?: number }
  | { type: "rehydrate"; username: string };

const channel: BroadcastChannel | null =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel("wavespeed:history")
    : null;

if (channel) {
  channel.addEventListener("message", (ev: MessageEvent<BroadcastMessage>) => {
    const msg = ev.data;
    debugHistory("broadcast.recv", msg);
    switch (msg.type) {
      case "delete":
        void deleteEntry(msg.serverGenId ?? msg.id, { skipServerDelete: true });
        break;
      case "rehydrate":
        void hydrateFromServer({ username: msg.username });
        break;
    }
  });
}

export const broadcast = {
  post(msg: BroadcastMessage): void {
    if (!channel) return;
    channel.postMessage(msg);
    debugHistory("broadcast.send", msg);
  },
};
