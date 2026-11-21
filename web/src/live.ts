import { useEffect, useRef } from "react";
import { getToken } from "./api";

// Live updates without refreshing: keeps one Server-Sent-Events stream open and calls
// onChange whenever the server says something changed. (EventSource cannot send an
// Authorization header, so this reads the stream with fetch.) Reconnects if it drops.
export function useLive(onChange: () => void, enabled: boolean) {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const controller = new AbortController();

    (async () => {
      while (!stopped) {
        try {
          const res = await fetch("/api/events", { headers: { authorization: `Bearer ${getToken()}` }, signal: controller.signal });
          if (!res.ok || !res.body) throw new Error("stream refused");
          latest.current(); // catch up on anything missed while disconnected
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (decoder.decode(value).includes("data:")) latest.current();
          }
        } catch {
          if (stopped) return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [enabled]);
}
