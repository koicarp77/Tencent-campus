import { computed, ref, watch, getCurrentScope, onScopeDispose } from "vue";
import {
  business,
  contentLength,
  type Annotation,
  type ImageInfo,
  type Review,
  type PatchBody,
  annotationChanges,
  type DraftBackup,
  type SavedSubmission,
} from "../../../packages/shared/src/contracts";
import { request, HttpError } from "./api";
import { useDraftBackup } from "./useDraftBackup";
import { useGroupEvents, type GroupChange } from "./useGroupEvents";
export function useReview(groupId = "default-group", actorId = "operator-1") {
  const images = ref<ImageInfo[]>([]),
    operators = ref<{ id: string; name: string }[]>([]),
    current = ref<Review | null>(null),
    draft = ref<Annotation[]>([]),
    actor = ref(actorId),
    selected = ref(""),
    status = ref("clean"),
    message = ref(""),
    loading = ref(false);
  const remoteReview = ref<Review | null>(null),
    realtimePaused = ref(false),
    remoteDeleted = ref<"image" | "group" | null>(null),
    realtimeAccessLost = ref(false),
    syncError = ref("");
  const unavailable = computed(
    () => !!remoteDeleted.value || realtimeAccessLost.value,
  );
  const pending = ref<{ kind: "image" | "actor"; id: string } | null>(null);
  type SaveAttempt = {
    imageId: string;
    body: PatchBody;
    expectedAnnotations: Annotation[];
    draft: Annotation[];
    deferredIds: string[];
    selectedId: string;
  };
  let attempt: SaveAttempt | null = null;
  let disposed = false,
    refreshPending = false,
    refreshRunning = false,
    refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const events = useGroupEvents(
    groupId,
    actorId,
    (event: GroupChange | null) => {
      if (event?.type === "group-deleted") {
        resourceDeleted("group");
        return;
      }
      queueRefresh();
    },
    () => {
      realtimeAccessLost.value = true;
      syncError.value =
        "实时连接权限已失效，请复制需要保留的草稿，再返回群组或重新登录。";
    },
  );
  const dirty = computed(
    () =>
      !!current.value &&
      business(draft.value) !== business(current.value.annotations),
  );
  const backup = useDraftBackup(
    () =>
      current.value
        ? {
            imageId: current.value.image.id,
            baseRevision: current.value.image.revision,
            baseAnnotations: current.value.annotations,
            annotations: draft.value,
            selectedId: selected.value || null,
            dirty: dirty.value,
            ready: !loading.value,
          }
        : null,
    (saved: DraftBackup) => {
      if (!current.value) return;
      const latest = current.value;
      remoteReview.value = null;
      const history = new Map(latest.annotations.map((a) => [a.id, a]));
      draft.value = saved.annotations.map((a) => ({
        ...history.get(a.id),
        ...a,
      }));
      selected.value = saved.selectedId || draft.value[0]?.id || "";
      if (saved.baseRevision !== latest.image.revision) {
        current.value = {
          ...latest,
          image: { ...latest.image, revision: saved.baseRevision },
          annotations: saved.baseAnnotations,
        };
        status.value = "dirty";
        message.value =
          "旧版本草稿已恢复。保存时后端将合并新增内容，同一标记的不同修改会分别保留。";
      } else {
        status.value = dirty.value ? "dirty" : "clean";
        message.value = "已恢复未保存草稿，请检查后点击保存标注。";
      }
      queueRefresh();
    },
    actorId,
  );
  const locked = computed(
    () =>
      loading.value ||
      backup.backupAction.value ||
      backup.recoveries.value.length > 0 ||
      ["saving", "unconfirmed"].includes(status.value),
  );
  const invalid = computed(() =>
    draft.value.findIndex(
      (a) => contentLength(a.content) < 1 || contentLength(a.content) > 500,
    ),
  );
  function adopt(r: Review) {
    if (!realtimeAccessLost.value) syncError.value = "";
    remoteReview.value = null;
    remoteDeleted.value = null;
    current.value = structuredClone(r);
    draft.value = structuredClone(r.annotations);
    selected.value = "";
    status.value = "clean";
    message.value = "";
    attempt = null;
  }
  function confirmSave(r: Review, confirmed: SaveAttempt, reconciled = false) {
    const deferred = new Set(confirmed.deferredIds);
    current.value = structuredClone(r);
    remoteReview.value = null;
    draft.value = structuredClone(r.annotations);
    for (const [index, a] of confirmed.draft.entries()) {
      if (!deferred.has(a.id)) continue;
      const existing = draft.value.findIndex((item) => item.id === a.id);
      if (existing >= 0) draft.value[existing] = structuredClone(a);
      else
        draft.value.splice(
          Math.min(index, draft.value.length),
          0,
          structuredClone(a),
        );
    }
    // Start cleanup immediately; a slow backup must not delay formal save confirmation.
    void backup.flush();
    selected.value = deferred.size ? confirmed.selectedId : "";
    status.value = deferred.size ? "partial" : "clean";
    message.value = deferred.size
      ? `${reconciled ? "已核对：" : ""}已保存已完成的修改；还有 ${deferred.size} 条说明未完成，仍保留在当前草稿。补全后再保存，请留意草稿自动备份状态，补全后再正式保存。`
      : r.mergeInfo?.rebased
        ? `已保存并合并双方修改；${r.mergeInfo.forks.length ? "同一标记的不同内容已分别保留。" : "其他人的标记已保留。"}`
        : reconciled
          ? "已核对：内容已保存"
          : "";
    attempt = null;
    // A delayed successful response cannot revive a group deleted meanwhile.
    if (remoteDeleted.value === "group" && deferred.size === 0) {
      backup.reset();
      current.value = null;
      draft.value = [];
      selected.value = "";
      syncError.value = "此群组已被删除，请返回群组列表。";
    }
    // A pending image/operator switch must never discard deferred drafts.
    return deferred.size === 0;
  }
  async function load(id: string) {
    loading.value = true;
    remoteReview.value = null;
    try {
      const loaded = await request<Review>(`/api/images/${id}/review`);
      if (
        disposed ||
        remoteDeleted.value === "group" ||
        realtimeAccessLost.value
      )
        return;
      adopt(loaded);
      await backup.open(id, current.value!.annotations);
      const url = new URL(window.location.href);
      url.searchParams.set("image", id);
      window.history.replaceState(null, "", url);
    } catch (e) {
      message.value = String(e instanceof Error ? e.message : e);
    } finally {
      loading.value = false;
    }
  }
  async function init() {
    try {
      [images.value, operators.value] = await Promise.all([
        request<ImageInfo[]>(
          `/api/images?groupId=${encodeURIComponent(groupId)}`,
        ),
        request<{ id: string; name: string }[]>(
          `/api/operators?groupId=${encodeURIComponent(groupId)}`,
        ),
      ]);
      const requested = new URLSearchParams(window.location.search).get(
        "image",
      );
      if (images.value[0])
        await load(
          images.value.find((i) => i.id === requested)?.id ||
            images.value[0].id,
        );
    } catch {
      message.value = "无法连接服务，请检查后端是否启动";
    } finally {
      if (!disposed) events.start();
    }
  }
  function edit() {
    if (!["conflict", "unconfirmed"].includes(status.value)) {
      status.value = dirty.value ? "dirty" : "clean";
      message.value = "";
    }
  }
  function add(x: number, y: number) {
    if (locked.value || unavailable.value || status.value === "conflict")
      return;
    if (draft.value.length >= 100) {
      message.value = "每张图片最多100个标记";
      return;
    }
    const id = crypto.randomUUID();
    draft.value.push({ id, x, y, content: "", sortOrder: draft.value.length });
    selected.value = id;
    edit();
  }
  function remove(id: string) {
    draft.value = draft.value.filter((a) => a.id !== id);
    selected.value = draft.value[0]?.id || "";
    edit();
  }
  async function reconcile() {
    if (!attempt) return false;
    status.value = "unconfirmed";
    message.value = "保存结果尚未确认，正在核对服务端…";
    try {
      let receipt: SavedSubmission | null = null;
      if (attempt.body.submissionId) {
        try {
          receipt = await request<SavedSubmission>(
            `/api/images/${attempt.imageId}/submissions/${attempt.body.submissionId}`,
          );
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 404)) throw e;
        }
      }
      const r = await request<Review>(`/api/images/${attempt.imageId}/review`);
      if (
        receipt &&
        business(r.annotations) === business(receipt.review.annotations)
      ) {
        return confirmSave(
          { ...r, mergeInfo: receipt.review.mergeInfo },
          attempt,
          true,
        );
      }
      if (business(r.annotations) === business(attempt.expectedAnnotations)) {
        return confirmSave(r, attempt, true);
      }
      if (r.image.revision === attempt.body.baseRevision) {
        status.value = "error";
        message.value = "已核对：本次修改尚未保存，可以重试";
        return false;
      }
      status.value = "conflict";
      message.value = "这张图已被其他人修改，本地草稿已保留";
      return false;
    } catch {
      message.value = "保存结果尚未确认，请保持页面打开并再次核对";
      return false;
    }
  }
  async function save() {
    if (
      locked.value ||
      !current.value ||
      unavailable.value ||
      status.value === "conflict" ||
      !dirty.value
    )
      return false;
    const snapshot: Annotation[] = JSON.parse(JSON.stringify(draft.value));
    const previous = new Map(current.value.annotations.map((a) => [a.id, a]));
    const deferredIds: string[] = [];
    const annotations: Annotation[] = [];
    for (const a of snapshot) {
      if (contentLength(a.content) >= 1 && contentLength(a.content) <= 500) {
        annotations.push(a);
      } else {
        deferredIds.push(a.id);
        // An incomplete edit is not an instruction to delete persisted data.
        const saved = previous.get(a.id);
        if (saved) annotations.push(JSON.parse(JSON.stringify(saved)));
      }
    }
    if (business(annotations) === business(current.value.annotations)) {
      selected.value = deferredIds[0] || selected.value;
      message.value =
        "没有其他待保存的有效修改；未完成标记的说明须为1—500个字符，仍保留在当前草稿。";
      return false;
    }
    const changes = annotationChanges(current.value.annotations, annotations);
    if (
      !changes.added.length &&
      !changes.updated.length &&
      !changes.deleted.length
    )
      return false;
    const submissionId =
      attempt &&
      attempt.body.actorId === actor.value &&
      attempt.body.baseRevision === current.value.image.revision &&
      business(attempt.expectedAnnotations) === business(annotations)
        ? attempt.body.submissionId
        : crypto.randomUUID();
    attempt = {
      imageId: current.value.image.id,
      draft: snapshot,
      expectedAnnotations: annotations,
      deferredIds,
      selectedId: selected.value,
      body: {
        submissionId,
        actorId: actor.value,
        baseRevision: current.value.image.revision,
        ...changes,
      },
    };
    status.value = "saving";
    message.value = "";
    void backup.flush();
    try {
      const r = await request<Review>(
        `/api/images/${attempt.imageId}/annotations`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attempt.body),
        },
      );
      return confirmSave(r, attempt);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        status.value = "conflict";
        message.value = e.message;
        return false;
      }
      if (e instanceof HttpError && e.status < 600) {
        status.value = "error";
        message.value = e.message;
        return false;
      }
      return await reconcile();
    }
  }
  async function forgetDeletedImage(id: string) {
    if (current.value?.image.id !== id) {
      images.value = images.value.filter((image) => image.id !== id);
      return;
    }
    remoteReview.value = null;
    remoteDeleted.value = null;
    backup.reset();
    images.value = images.value.filter((image) => image.id !== id);
    current.value = null;
    draft.value = [];
    selected.value = "";
    status.value = "clean";
    message.value = "";
    pending.value = null;
    attempt = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("image");
    window.history.replaceState(null, "", url);
    if (images.value[0]) await load(images.value[0].id);
    if (!message.value) message.value = "图片已删除";
  }
  async function performSwitch(p: { kind: "image" | "actor"; id: string }) {
    if (p.kind === "actor") {
      actor.value = p.id;
      draft.value = JSON.parse(
        JSON.stringify(current.value?.annotations || []),
      );
      status.value = "clean";
      message.value = "";
    } else await load(p.id);
  }
  async function switchTo(kind: "image" | "actor", id: string) {
    if (
      locked.value ||
      id === (kind === "actor" ? actor.value : current.value?.image.id)
    )
      return;
    if (dirty.value) {
      pending.value = { kind, id };
      return;
    }
    await performSwitch({ kind, id });
  }
  async function resolveSwitch(choice: "save" | "discard" | "cancel") {
    const p = pending.value;
    if (!p) return;
    if (choice === "cancel") {
      pending.value = null;
      return;
    }
    if (choice === "save" && !(await save())) {
      pending.value = null;
      return;
    }
    if (choice === "discard" && unavailable.value) backup.reset();
    else if (choice === "discard" && !(await backup.discardCurrent())) {
      message.value = backup.backupError.value;
      return;
    }
    pending.value = null;
    await performSwitch(p);
  }
  const remoteChanges = computed(() => {
    const latest = remoteReview.value,
      base = current.value;
    if (
      !latest ||
      !base ||
      latest.image.id !== base.image.id ||
      latest.image.revision <= base.image.revision
    )
      return [];
    const old = new Map(base.annotations.map((a) => [a.id, a]));
    const next = new Set(latest.annotations.map((a) => a.id));
    const changed = latest.annotations.flatMap((a, index) => {
      const previous = old.get(a.id);
      return !previous ||
        previous.x !== a.x ||
        previous.y !== a.y ||
        previous.content !== a.content
        ? [
            {
              id: a.id,
              label: `${a.updatedByName || "组员"} · 标记 ${index + 1}`,
              content: a.content,
              deleted: false,
            },
          ]
        : [];
    });
    return [
      ...changed,
      ...base.annotations
        .filter((a) => !next.has(a.id))
        .map((a) => ({
          id: a.id,
          label: "标记已被其他人删除",
          content: a.content,
          deleted: true,
        })),
    ];
  });
  function resourceDeleted(kind: "image" | "group") {
    remoteDeleted.value = kind;
    remoteReview.value = null;
    syncError.value =
      kind === "group"
        ? "此群组已被删除，无法继续保存。未保存的草稿仍保留在页面，可复制后返回群组。"
        : "当前照片已被删除，无法继续保存。未保存的草稿仍保留在页面，可复制后切换照片。";
    if (kind === "group") {
      events.stop();
      images.value = [];
      if (!dirty.value && !["saving", "unconfirmed"].includes(status.value)) {
        backup.reset();
        current.value = null;
        draft.value = [];
        selected.value = "";
      }
    }
  }
  function refreshBlocked() {
    return (
      disposed ||
      remoteDeleted.value === "group" ||
      realtimeAccessLost.value ||
      loading.value ||
      realtimePaused.value ||
      backup.backupAction.value ||
      ["saving", "unconfirmed"].includes(status.value)
    );
  }
  function queueRefresh() {
    if (disposed || realtimeAccessLost.value || remoteDeleted.value === "group")
      return;
    refreshPending = true;
    if (!refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refreshShared();
      }, 50);
  }
  async function refreshShared() {
    if (refreshRunning || refreshBlocked() || !refreshPending) return;
    refreshRunning = true;
    refreshPending = false;
    const startingImage = current.value?.image.id;
    try {
      const latestImages = await request<ImageInfo[]>(
        `/api/images?groupId=${encodeURIComponent(groupId)}`,
      );
      if (disposed) return;
      if (refreshBlocked() || current.value?.image.id !== startingImage) {
        refreshPending = true;
        return;
      }
      images.value = latestImages;
      if (
        startingImage &&
        !latestImages.some((image) => image.id === startingImage)
      ) {
        if (dirty.value || status.value === "conflict")
          resourceDeleted("image");
        else await forgetDeletedImage(startingImage);
      } else if (startingImage) {
        const latest = await request<Review>(
          `/api/images/${startingImage}/review`,
        );
        if (disposed) return;
        if (refreshBlocked() || current.value?.image.id !== startingImage) {
          refreshPending = true;
          return;
        }
        receiveShared(latest);
      } else if (latestImages[0]) await load(latestImages[0].id);
      if (!unavailable.value) syncError.value = "";
    } catch (e) {
      if (disposed) return;
      if (e instanceof HttpError && [401, 403, 412].includes(e.status)) {
        realtimeAccessLost.value = true;
        events.stop();
        syncError.value =
          "共享数据访问权限已失效，草稿仍保留，请重新登录或返回群组。";
      } else if (e instanceof HttpError && e.status === 404) {
        // The resource may have disappeared between list and review reads.
        refreshPending = true;
      } else {
        syncError.value = "暂时无法读取最新标注，正在重试；当前草稿已保留。";
        refreshPending = true;
      }
    } finally {
      refreshRunning = false;
      if (
        refreshPending &&
        !refreshBlocked() &&
        !refreshTimer &&
        !unavailable.value
      )
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void refreshShared();
        }, 1500);
    }
  }
  function receiveShared(latest: Review) {
    const base = current.value;
    if (
      !base ||
      base.image.id !== latest.image.id ||
      latest.image.revision <= base.image.revision
    )
      return;
    if (
      dirty.value ||
      backup.recoveries.value.length ||
      status.value === "conflict"
    ) {
      if (
        !remoteReview.value ||
        latest.image.revision >= remoteReview.value.image.revision
      )
        remoteReview.value = structuredClone(latest);
      return;
    }
    const selection = selected.value,
      savedMessage = message.value;
    adopt(latest);
    selected.value = latest.annotations.some((a) => a.id === selection)
      ? selection
      : "";
    message.value = savedMessage;
  }
  const stopRefreshWatch = watch(
    () => [
      loading.value,
      realtimePaused.value,
      status.value,
      backup.backupAction.value,
      backup.recoveries.value.length,
      dirty.value,
      current.value?.image.id,
    ],
    () => {
      if (refreshPending && !refreshBlocked()) queueRefresh();
      if (
        remoteReview.value &&
        !dirty.value &&
        !refreshBlocked() &&
        !backup.recoveries.value.length &&
        status.value !== "conflict"
      )
        receiveShared(remoteReview.value);
    },
    { flush: "post" },
  );
  function stopRealtime() {
    disposed = true;
    events.stop();
    stopRefreshWatch();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  if (getCurrentScope()) onScopeDispose(stopRealtime);
  return {
    images,
    remoteReview,
    remoteChanges,
    remoteDeleted,
    realtimeAccessLost,
    unavailable,
    realtimePaused,
    realtimeConnection: events.connection,
    syncError,
    stopRealtime,
    operators,
    current,
    draft,
    actor,
    selected,
    status,
    message,
    loading,
    pending,
    dirty,
    locked,
    invalid,
    init,
    load,
    edit,
    add,
    remove,
    save,
    reconcile,
    switchTo,
    resolveSwitch,
    forgetDeletedImage,
    backupAction: backup.backupAction,
    backupStatus: backup.backupStatus,
    backupTime: backup.backupTime,
    backupError: backup.backupError,
    recoveries: backup.recoveries,
    restoreDraft: backup.restoreDraft,
    discardRecovery: backup.discardRecovery,
    flushBackup: backup.flush,
    discardBackup: backup.discardCurrent,
  };
}
