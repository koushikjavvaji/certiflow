import { useEffect, useRef } from "react";
import { getToken } from "./api";

// Live updates without refreshing, using ONE stream per browser, not one per tab.
//
// Why: a browser allows only about 6 simultaneous connections to one site (plain HTTP/1.1).
// A live stream never ends, so with 6 tabs open every slot was taken and nothing else (a
// page refresh, a click) could get through: pages looked frozen.
//
// How: the tabs elect a "leader" with the Web Locks API. Only the leader keeps the
// Server-Sent-Events stream open; each time it hears "something changed" it tells every
// other tab through a BroadcastChannel, and each tab re-fetches with ITS OWN login. The
// events are only hints (ids, no data), so sharing them across differently signed-in tabs
// leaks nothing. If the leader tab closes, the lock is released and another tab takes over.
const LOCK_NAME = "certiflow-live-leader";
const CHANNEL_NAME = "certiflow-live";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useLive(onChange: () => void, enabled: boolean) {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    const stop = new AbortController();
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => latest.current(); // an event the leader heard

    const changed = () => {
      latest.current(); // this tab
      channel.postMessage("changed"); // every other tab
    };

    // Runs only while this tab is the leader. Returns when the stream ends or fails, which
    // releases the lock so a waiting tab can take over (and we queue up again behind it).
    async function lead() {
      try {
        const res = await fetch("/api/events", { headers: { authorization: `Bearer ${getToken()}` }, signal: stop.signal });
        if (!res.ok || !res.body) return;
        changed(); // catch up on anything missed while nobody was listening
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          if (decoder.decode(value).includes("data:")) changed();
        }
      } catch {
        /* aborted or network error: give up the lock and retry below */
      }
    }

    (async () => {
      while (!stop.signal.aborted) {
        try {
          if ("locks" in navigator) await navigator.locks.request(LOCK_NAME, { signal: stop.signal }, lead);
          else await lead(); // very old browsers: every tab streams (the old behaviour)
        } catch {
          /* aborted while waiting for the lock */
        }
        if (!stop.signal.aborted) await sleep(2000);
      }
    })();

    return () => {
      stop.abort();
      channel.close();
    };
  }, [enabled]);
}
