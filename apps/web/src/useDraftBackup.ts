import { getCurrentScope, onScopeDispose, ref, watch } from "vue";
import { request as httpRequest, HttpError } from "./api";
import {
  business,
  type Annotation,
  type DraftBackup,
} from "../../../packages/shared/src/contracts";
export interface BackupSnapshot {
  imageId: string;
  baseRevision: number;
  baseAnnotations: Annotation[];
  annotations: Annotation[];
  selectedId: string | null;
  dirty: boolean;
  ready: boolean;
}
type Context = {
  imageId: string;
  id: string;
  version: number;
  lastKey: string;
  sent: boolean;
  checked: boolean;
  source: DraftBackup | null;
  pending: Promise<boolean> | null;
};
export function useDraftBackup(
  snapshot: () => BackupSnapshot | null,
  restore: (backup: DraftBackup) => void,
  ownerId: string,
) {
  const enabled = typeof window !== "undefined";
  const backupStatus = ref("idle"),
    backupTime = ref(""),
    backupError = ref(""),
    backupAction = ref(false),
    recoveries = ref<DraftBackup[]>([]);
  let context: Context | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    waitingSince = 0,
    disposed = false;
  function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    if (disposed)
      return Promise.reject(new Error("编辑窗口已关闭，停止草稿备份"));
    const headers = new Headers(options.headers);
    headers.set("X-Draft-Owner", ownerId);
    return httpRequest<T>(url, { ...options, headers });
  }
  const key = (value: BackupSnapshot) =>
    JSON.stringify({
      baseRevision: value.baseRevision,
      baseAnnotations: value.baseAnnotations,
      annotations: value.annotations,
      selectedId: value.selectedId,
    });
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  function schedule(delay = 500) {
    if (!enabled || disposed) return;
    if (recoveries.value.length) return;
    const value = snapshot();
    if (
      !value?.ready ||
      !context ||
      !context.checked ||
      value.imageId !== context.imageId
    )
      return;
    cancel();
    if (value.dirty && !waitingSince) waitingSince = Date.now();
    if (!value.dirty) waitingSince = 0;
    if (value.dirty && backupStatus.value !== "error")
      backupStatus.value = "waiting";
    timer = setTimeout(
      () => {
        timer = undefined;
        void flush();
      },
      value.dirty && delay <= 500
        ? Math.min(delay, Math.max(0, 2000 - (Date.now() - waitingSince)))
        : delay,
    );
  }
  async function erase(imageId: string, id: string, expectedVersion: number) {
    await request(`/api/images/${imageId}/drafts/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion }),
    });
  }
  async function clearContext(c: Context) {
    if (c.sent) {
      let version = c.version;
      try {
        version = (
          await request<DraftBackup>(`/api/images/${c.imageId}/drafts/${c.id}`)
        ).version;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
      try {
        await erase(c.imageId, c.id, version);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
      c.sent = false;
      c.version = 0;
      c.id = crypto.randomUUID();
      c.lastKey = "";
    }
    if (c.source) {
      try {
        await erase(c.imageId, c.source.id, c.source.version);
      } catch (e) {
        if (!(e instanceof HttpError && [404, 409].includes(e.status))) throw e;
      }
      c.source = null;
    }
  }
  async function flush(keepalive = false): Promise<boolean> {
    cancel();
    waitingSince = 0;
    const c = context;
    if (!enabled || !c || disposed || recoveries.value.length)
      return !recoveries.value.length;
    if (c.pending) {
      await c.pending;
      if (context !== c) return false;
      return flush(keepalive);
    }
    const value = snapshot();
    if (!value?.ready || value.imageId !== c.imageId) return false;
    if (!c.checked) {
      try {
        const rows = await request<DraftBackup[]>(
          `/api/images/${c.imageId}/drafts`,
        );
        if (context !== c) return false;
        c.checked = true;
        recoveries.value = rows.filter(
          (row) =>
            business(row.annotations) !== business(value.baseAnnotations),
        );
        backupError.value = "";
        if (recoveries.value.length) {
          backupStatus.value = "idle";
          return false;
        }
      } catch (e) {
        backupStatus.value = "error";
        backupError.value =
          "无法查询可恢复草稿：" + (e instanceof Error ? e.message : String(e));
        if (!disposed)
          timer = setTimeout(() => {
            void flush();
          }, 5000);
        return false;
      }
    }
    if (value.dirty && key(value) === c.lastKey) {
      backupStatus.value = "saved";
      return true;
    }
    c.pending = (async () => {
      try {
        if (!value.dirty) {
          await clearContext(c);
          if (context === c) {
            backupStatus.value = "idle";
            backupError.value = "";
          }
          return true;
        }
        const frozen = JSON.parse(JSON.stringify(value)) as BackupSnapshot;
        if (context === c) backupStatus.value = "saving";
        let result: DraftBackup | undefined;
        for (let tries = 0; tries < 2; tries++) {
          const body = JSON.stringify({
            expectedVersion: c.version,
            baseRevision: frozen.baseRevision,
            baseAnnotations: frozen.baseAnnotations,
            annotations: frozen.annotations,
            selectedId: frozen.selectedId,
          });
          c.sent = true;
          try {
            result = await request<DraftBackup>(
              `/api/images/${c.imageId}/drafts/${c.id}`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body,
                keepalive:
                  keepalive && new TextEncoder().encode(body).length < 60_000,
              },
            );
            break;
          } catch (e) {
            if (tries === 0 && e instanceof HttpError && e.status === 409) {
              // This ID belongs only to this editing branch. A timed-out PUT
              // may already have committed; read its version before retrying.
              // Cleared branches stay cleared and receive a new ID instead.
              let stored: DraftBackup | null = null;
              try {
                stored = await request<DraftBackup>(
                  `/api/images/${c.imageId}/drafts/${c.id}`,
                );
              } catch (check) {
                if (!(check instanceof HttpError && check.status === 404))
                  throw check;
              }
              if (stored && !stored.cleared) c.version = stored.version;
              else {
                c.id = crypto.randomUUID();
                c.version = 0;
              }
              c.lastKey = "";
              continue;
            }
            throw e;
          }
        }
        if (!result) throw new Error("草稿备份未确认");
        c.version = result.version;
        c.lastKey = key(frozen);
        if (c.source) {
          try {
            await erase(c.imageId, c.source.id, c.source.version);
          } catch {
            /* The new branch is already durable; never delete a changed old branch. */
          }
          c.source = null;
        }
        if (context === c) {
          backupStatus.value = "saved";
          backupTime.value = result.updatedAt;
          backupError.value = "";
        }
        return true;
      } catch (e) {
        if (context === c) {
          backupStatus.value = "error";
          backupError.value = e instanceof Error ? e.message : String(e);
        }
        return false;
      }
    })();
    const success = await c.pending;
    c.pending = null;
    if (context === c && !disposed) {
      const latest = snapshot();
      if (
        success &&
        latest?.ready &&
        latest.imageId === c.imageId &&
        ((latest.dirty && key(latest) !== c.lastKey) ||
          (!latest.dirty && c.sent))
      )
        schedule(0);
      else if (!success) schedule(5000);
    }
    return success;
  }
  async function open(imageId: string, server: Annotation[]) {
    if (!enabled) return;
    cancel();
    recoveries.value = [];
    backupStatus.value = "idle";
    backupTime.value = "";
    backupError.value = "";
    const c: Context = {
      imageId,
      id: crypto.randomUUID(),
      version: 0,
      lastKey: "",
      sent: false,
      checked: false,
      source: null,
      pending: null,
    };
    context = c;
    waitingSince = 0;
    try {
      const rows = await request<DraftBackup[]>(
        `/api/images/${imageId}/drafts`,
      );
      if (context === c) {
        c.checked = true;
        recoveries.value = rows.filter(
          (row) => business(row.annotations) !== business(server),
        );
      }
    } catch (e) {
      if (context === c) {
        backupStatus.value = "error";
        backupError.value =
          "无法查询可恢复草稿：" + (e instanceof Error ? e.message : String(e));
        timer = setTimeout(() => {
          void flush();
        }, 5000);
      }
    }
  }
  function restoreDraft(id: string) {
    const row = recoveries.value.find((value) => value.id === id);
    if (!row || !context || backupAction.value) return;
    context.source = JSON.parse(JSON.stringify(row));
    recoveries.value = [];
    restore(JSON.parse(JSON.stringify(row)));
    schedule(0);
  }
  async function discardRecovery() {
    if (!context || backupAction.value) return false;
    cancel();
    backupAction.value = true;
    backupStatus.value = "saving";
    try {
      for (const row of recoveries.value)
        await erase(context.imageId, row.id, row.version);
      recoveries.value = [];
      backupStatus.value = "idle";
      backupError.value = "";
      if (snapshot()?.dirty) schedule(0);
      return true;
    } catch (e) {
      backupStatus.value = "error";
      backupError.value =
        "未能放弃备份，请重试：" + (e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      backupAction.value = false;
    }
  }
  async function discardCurrent() {
    cancel();
    const c = context;
    if (!enabled || !c) return true;
    if (backupAction.value) return false;
    backupAction.value = true;
    if (c.pending) await c.pending;
    cancel();
    try {
      await clearContext(c);
      if (context === c) {
        backupStatus.value = "idle";
        backupError.value = "";
      }
      return true;
    } catch (e) {
      backupStatus.value = "error";
      backupError.value =
        "未能清理草稿备份，当前草稿已保留：" +
        (e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      backupAction.value = false;
    }
  }
  const stop = enabled
    ? watch(
        () => JSON.stringify(snapshot()),
        () => schedule(),
        { flush: "post" },
      )
    : () => {};
  const hidden = () => {
    if (document.visibilityState === "hidden") void flush(true);
  };
  const pagehide = () => {
    void flush(true);
  };
  if (enabled) {
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", pagehide);
  }
  function dispose() {
    disposed = true;
    cancel();
    stop();
    if (enabled) {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", pagehide);
    }
  }
  function reset() {
    cancel();
    context = null;
    waitingSince = 0;
    recoveries.value = [];
    backupStatus.value = "idle";
    backupError.value = "";
    backupTime.value = "";
  }
  if (getCurrentScope()) onScopeDispose(dispose);
  return {
    backupStatus,
    backupTime,
    backupError,
    backupAction,
    recoveries,
    open,
    restoreDraft,
    discardRecovery,
    discardCurrent,
    flush,
    reset,
    dispose,
  };
}
