import { computed, ref } from "vue";
import {
  business,
  contentLength,
  type Annotation,
  type ImageInfo,
  type Review,
  type SaveBody,
} from "../../../packages/shared/src/contracts";
import { request, HttpError } from "./api";
export function useReview() {
  const images = ref<ImageInfo[]>([]),
    operators = ref<{ id: string; name: string }[]>([]),
    current = ref<Review | null>(null),
    draft = ref<Annotation[]>([]),
    actor = ref("operator-1"),
    selected = ref(""),
    status = ref("clean"),
    message = ref(""),
    loading = ref(false);
  const pending = ref<{ kind: "image" | "actor"; id: string } | null>(null);
  let attempt: { imageId: string; body: SaveBody } | null = null;
  const dirty = computed(
    () =>
      !!current.value &&
      business(draft.value) !== business(current.value.annotations),
  );
  const locked = computed(
    () => loading.value || ["saving", "unconfirmed"].includes(status.value),
  );
  const invalid = computed(() =>
    draft.value.findIndex(
      (a) => contentLength(a.content) < 1 || contentLength(a.content) > 500,
    ),
  );
  function adopt(r: Review) {
    current.value = structuredClone(r);
    draft.value = structuredClone(r.annotations);
    selected.value = "";
    status.value = "clean";
    message.value = "";
    attempt = null;
  }
  async function load(id: string) {
    loading.value = true;
    try {
      adopt(await request<Review>(`/api/images/${id}/review`));
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
        request<ImageInfo[]>("/api/images"),
        request<{ id: string; name: string }[]>("/api/operators"),
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
    }
  }
  function edit() {
    if (!["conflict", "unconfirmed"].includes(status.value)) {
      status.value = dirty.value ? "dirty" : "clean";
      message.value = "";
    }
  }
  function add(x: number, y: number) {
    if (locked.value || status.value === "conflict") return;
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
      const r = await request<Review>(`/api/images/${attempt.imageId}/review`);
      if (business(r.annotations) === business(attempt.body.annotations)) {
        adopt(r);
        message.value = "已核对：内容已保存";
        return true;
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
      status.value === "conflict" ||
      !dirty.value
    )
      return false;
    if (invalid.value >= 0) {
      selected.value = draft.value[invalid.value].id;
      message.value = `标记 ${invalid.value + 1} 的说明须为1—500个字符`;
      return false;
    }
    attempt = {
      imageId: current.value.image.id,
      body: {
        actorId: actor.value,
        baseRevision: current.value.image.revision,
        annotations: JSON.parse(JSON.stringify(draft.value)),
      },
    };
    status.value = "saving";
    message.value = "";
    try {
      const r = await request<Review>(
        `/api/images/${attempt.imageId}/annotations`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attempt.body),
        },
      );
      adopt(r);
      return true;
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
    pending.value = null;
    await performSwitch(p);
  }
  return {
    images,
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
  };
}
