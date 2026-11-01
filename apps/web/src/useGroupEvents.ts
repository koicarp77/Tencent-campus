import { ref } from "vue";
import { request, HttpError } from "./api";
import type { Account } from "../../../packages/shared/src/contracts";
export type GroupChange = {
  type: "review" | "images" | "group-deleted";
  imageId?: string;
  revision?: number;
};
/** Notifications carry no business text. Every ready/reconnect triggers an authoritative read. */
export function useGroupEvents(
  groupId: string,
  owner: string,
  onChange: (event: GroupChange | null) => void,
  onAccessLost: () => void,
) {
  const connection = ref("connecting");
  let source: EventSource | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = true,
    generation = 0;
  const supported =
    typeof window !== "undefined" && typeof EventSource !== "undefined";
  function disconnect() {
    source?.close();
    source = null;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function deny() {
    stop();
    connection.value = "denied";
    onAccessLost();
  }
  function connect() {
    if (stopped || !supported) return;
    disconnect();
    const attempt = ++generation;
    const stream = (source = new EventSource(
      `/api/groups/${encodeURIComponent(groupId)}/events?owner=${encodeURIComponent(owner)}`,
    ));
    stream.addEventListener("ready", () => {
      if (stopped || source !== stream) return;
      connection.value = "connected";
      onChange(null);
    });
    stream.addEventListener("change", (event) => {
      if (stopped || source !== stream) return;
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (data && ["review", "images", "group-deleted"].includes(data.type))
          onChange(data);
      } catch {
        /* Reconnect/read recovers missed or malformed notifications. */
      }
    });
    stream.addEventListener("access-lost", () => {
      if (!stopped && source === stream) deny();
    });
    stream.onerror = () => {
      if (stopped || source !== stream) return;
      disconnect();
      connection.value = "reconnecting";
      timer = setTimeout(async () => {
        timer = undefined;
        try {
          const { user } = await request<{ user: Account | null }>(
            "/api/auth/session",
          );
          if (stopped || attempt !== generation) return;
          if (!user || user.id !== owner) {
            deny();
            return;
          }
          await request(`/api/groups/${encodeURIComponent(groupId)}`);
        } catch (error) {
          if (stopped || attempt !== generation) return;
          if (
            error instanceof HttpError &&
            [401, 403, 404].includes(error.status)
          ) {
            deny();
            return;
          }
          /* Offline: reconnect when service returns. */
        }
        if (!stopped && attempt === generation) connect();
      }, 1500);
    };
  }
  function offline() {
    if (stopped) return;
    generation++;
    disconnect();
    connection.value = "reconnecting";
  }
  function online() {
    if (!stopped) connect();
  }
  function visible() {
    if (!stopped && document.visibilityState === "visible") onChange(null);
  }
  function start() {
    if (!supported || !stopped) return;
    stopped = false;
    connection.value = "connecting";
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    connect();
  }
  function stop() {
    stopped = true;
    generation++;
    disconnect();
    if (supported) {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
    }
  }
  return { connection, start, stop };
}
