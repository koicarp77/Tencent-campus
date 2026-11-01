<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { useReview } from "./useReview";
import { useViewportGestures } from "./useViewportGestures";
import { point, centerAnchor, clamp } from "./coordinates";
import {
  contentLength,
  type Review,
  type Account,
  type GroupInfo,
} from "../../../packages/shared/src/contracts";
import { request, UPLOAD_REQUEST_POLICY, HttpError } from "./api";
const props = defineProps<{ user: Account; group: GroupInfo }>();
const emit = defineEmits<{ leave: []; logout: [] }>();
const r = useReview(props.group.id, props.user.id);
const {
  images,
  operators,
  current,
  draft,
  selected,
  status,
  message,
  loading,
  pending,
  dirty,
  locked,
  backupAction,
  backupStatus,
  backupTime,
  backupError,
  recoveries,
  remoteChanges,
  remoteDeleted,
  realtimeAccessLost,
  unavailable,
  realtimeConnection,
  syncError,
} = r;
const viewport = ref<HTMLElement>(),
  plane = ref<HTMLElement>(),
  editor = ref<HTMLTextAreaElement>();
const zoom = ref("fit"),
  available = ref(600),
  imageReady = ref(false),
  uploading = ref(false),
  deleting = ref(false),
  leaving = ref(false),
  uploadInput = ref<HTMLInputElement>();
const resourceBusy = computed(
  () => uploading.value || deleting.value || leaving.value,
);
watch(
  resourceBusy,
  (value) => {
    r.realtimePaused.value = value;
  },
  { flush: "sync" },
);
const realtimeLabel = computed(() =>
  remoteDeleted.value === "group" || realtimeAccessLost.value
    ? "实时同步已停止"
    : {
        connecting: "正在连接实时同步…",
        connected: "实时同步已连接",
        reconnecting: "实时连接中断，正在重连…",
        denied: "实时同步权限已失效",
      }[realtimeConnection.value] || "实时同步已暂停",
);
const canDeletePhoto = computed(
  () =>
    !!current.value &&
    (current.value.image.createdBy === props.user.id ||
      props.group.createdBy === props.user.id),
);
const scale = computed(() =>
  current.value
    ? zoom.value === "fit"
      ? Math.min(1, (available.value - 80) / current.value.image.width)
      : Number(zoom.value)
    : 1,
);
const gestures = useViewportGestures(
  viewport,
  plane,
  () => scale.value,
  (value) => {
    zoom.value = String(value);
  },
  () => imageReady.value && !loading.value,
);
const recoveryId = ref("");
watch(recoveries, (rows) => {
  recoveryId.value = rows[0]?.id || "";
});
const backupLabel = computed(
  () =>
    ({
      idle: "草稿自动备份已开启",
      waiting: "草稿待备份",
      saving: "正在备份草稿…",
      saved: `草稿已备份 ${backupTime.value ? new Date(backupTime.value).toLocaleTimeString("zh-CN") : ""}`,
      error: "草稿备份失败",
    })[backupStatus.value],
);
function restoreFoundDraft() {
  if (
    dirty.value &&
    !window.confirm(
      "恢复备份会替换当前页面的草稿。请先复制需要保留的内容，确认恢复？",
    )
  )
    return;
  r.restoreDraft(recoveryId.value);
}
async function discardFoundDrafts() {
  if (
    window.confirm(
      "放弃检测到的草稿备份？这不会删除正式标注，但这些备份将无法恢复。",
    )
  )
    await r.discardRecovery();
}
const selectedItem = computed(() =>
  draft.value.find((a) => a.id === selected.value),
);
const statusText = computed(
  () =>
    ({
      clean: current.value?.image.revision ? "已保存" : "暂无修改",
      dirty: "有未保存修改",
      partial: "部分已保存 · 仍有草稿",
      saving: "保存中…",
      error: "保存失败",
      unconfirmed: "保存结果尚未确认",
      conflict: "版本冲突",
    })[status.value],
);
const canEdit = computed(
  () =>
    !locked.value &&
    !unavailable.value &&
    status.value !== "conflict" &&
    !resourceBusy.value,
);
watch(
  () => current.value?.image.id,
  () => {
    gestures.cancel();
    imageReady.value = false;
    if (viewport.value) {
      viewport.value.scrollTop = 0;
      viewport.value.scrollLeft = 0;
    }
  },
);
let observer: ResizeObserver;
let anchor = { x: 0.5, y: 0 };
function snapshotAnchor() {
  if (viewport.value && plane.value)
    anchor = centerAnchor(
      viewport.value.getBoundingClientRect(),
      plane.value.getBoundingClientRect(),
    );
}
async function restoreAnchor() {
  await nextTick();
  const v = viewport.value,
    p = plane.value;
  if (!v || !p) return;
  const vr = v.getBoundingClientRect(),
    pr = p.getBoundingClientRect();
  v.scrollLeft = clamp(
    v.scrollLeft + pr.left + anchor.x * pr.width - vr.left - v.clientWidth / 2,
    0,
    v.scrollWidth - v.clientWidth,
  );
  v.scrollTop = clamp(
    v.scrollTop + pr.top + anchor.y * pr.height - vr.top - v.clientHeight / 2,
    0,
    v.scrollHeight - v.clientHeight,
  );
}
async function setZoom(value: string) {
  gestures.cancel();
  snapshotAnchor();
  zoom.value = value;
  await restoreAnchor();
}
async function addPin(e: MouseEvent) {
  if (!imageReady.value || !canEdit.value || !plane.value) return;
  const p = point(e.clientX, e.clientY, plane.value.getBoundingClientRect());
  if (p) {
    r.add(p.x, p.y);
    await nextTick();
    editor.value?.focus();
  }
}
async function selectPin(id: string, scroll = false) {
  selected.value = id;
  await nextTick();
  if (scroll)
    document.getElementById(`pin-${id}`)?.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "smooth",
    });
}
function deletePin() {
  if (canEdit.value && !pending.value && selectedItem.value)
    r.remove(selected.value);
}
async function imageChange(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  await r.switchTo("image", id);
  (e.target as HTMLSelectElement).value = current.value?.image.id || "";
}
async function leaveWorkspace(action: "leave" | "logout") {
  if ((locked.value || resourceBusy.value) && !unavailable.value) return;
  if (
    unavailable.value &&
    (dirty.value || status.value === "unconfirmed" || recoveries.value.length)
  ) {
    if (
      !window.confirm(
        "当前资源或访问权限已失效，草稿无法继续备份。请先复制需要保留的说明，再确认离开。",
      )
    )
      return;
  } else if (dirty.value) {
    if (
      !window.confirm(
        "当前有未保存的修改。将先备份草稿再离开，重新进入时可恢复。确认继续？",
      )
    )
      return;
    leaving.value = true;
    if (!(await r.flushBackup())) {
      message.value = "草稿备份未成功，已保留当前页面，请稍后重试。";
      leaving.value = false;
      return;
    }
  }
  if (action === "leave") emit("leave");
  else emit("logout");
  leaving.value = false;
}
async function upload(e: Event) {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    message.value = "原始图片超过10MiB";
    input.value = "";
    return;
  }
  uploading.value = true;
  try {
    const form = new FormData();
    form.append("image", file);
    form.append("title", file.name);
    const result = await request<Review>(
      `/api/images?groupId=${encodeURIComponent(props.group.id)}`,
      { method: "POST", body: form },
      UPLOAD_REQUEST_POLICY,
    );
    if (!images.value.some((image) => image.id === result.image.id))
      images.value.push(result.image);
    await r.switchTo("image", result.image.id);
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e);
  } finally {
    uploading.value = false;
    input.value = "";
  }
}
async function deletePhoto() {
  if (
    !current.value ||
    locked.value ||
    resourceBusy.value ||
    pending.value ||
    !canDeletePhoto.value ||
    unavailable.value
  )
    return;
  const image = current.value.image;
  if (
    !window.confirm(
      `删除照片「${image.title}」？照片及其所有标记和草稿备份将永久删除，无法恢复。${dirty.value ? "当前未保存的标记草稿也将丢失。" : ""}`,
    )
  )
    return;
  deleting.value = true;
  try {
    try {
      await request(`/api/images/${image.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: image.revision }),
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        /* Already removed. */
      } else if (!(error instanceof HttpError)) {
        let gone = false;
        try {
          await request(`/api/images/${image.id}/review`);
        } catch (check) {
          gone = check instanceof HttpError && check.status === 404;
        }
        if (!gone)
          throw new Error(
            "删除结果尚未确认，当前草稿已保留。请刷新核对图片是否仍存在后再决定是否重试。",
          );
      } else throw error;
    }
    await r.forgetDeletedImage(image.id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409)
      status.value = "conflict";
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    deleting.value = false;
  }
}
async function reloadLatest() {
  if (window.confirm("加载最新版本会放弃本地草稿。确认继续？")) {
    if (await r.discardBackup()) await r.load(current.value!.image.id);
  }
}
async function copyDraft() {
  try {
    await navigator.clipboard.writeText(
      draft.value
        .map(
          (a, i) =>
            `${i + 1}. (${a.x.toFixed(4)}, ${a.y.toFixed(4)}) ${a.content}`,
        )
        .join("\n"),
    );
    message.value = "本地说明已复制";
  } catch {
    message.value = "复制失败，请手动选择右侧说明复制";
  }
}
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value || status.value === "unconfirmed") {
    e.preventDefault();
  }
}
function editorKeydown(e: KeyboardEvent) {
  if (
    e.key !== "Enter" ||
    e.shiftKey ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.isComposing ||
    e.keyCode === 229
  )
    return;
  e.preventDefault();
  if (!e.repeat && canEdit.value && !pending.value) void r.save();
}
function shortcut(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    if (canEdit.value && !pending.value) void r.save();
  }
  if (
    (e.key !== "Delete" && e.key !== "Backspace") ||
    e.isComposing ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.shiftKey ||
    !canEdit.value ||
    pending.value ||
    !selectedItem.value
  )
    return;
  const target = e.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [role="textbox"]'))
  )
    return;
  e.preventDefault();
  // Holding the key must not delete the next automatically selected markers.
  if (!e.repeat) deletePin();
}
onMounted(async () => {
  await r.init();
  gestures.attach();
  observer = new ResizeObserver(() => {
    snapshotAnchor();
    available.value = viewport.value?.clientWidth || 600;
    restoreAnchor();
  });
  if (viewport.value) {
    available.value = viewport.value.clientWidth;
    observer.observe(viewport.value);
  }
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("keydown", shortcut);
});
onBeforeUnmount(() => {
  r.stopRealtime();
  gestures.dispose();
  observer?.disconnect();
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("keydown", shortcut);
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a
        class="brand"
        href="/"
        aria-label="审图台首页"
        @click.prevent="leaveWorkspace('leave')"
        ><span class="brand-icon">⌖</span>
        <div>审图台<small>REVIEW DESK</small></div></a
      >
      <div class="project-label">
        <span class="live-dot"></span>{{ props.group.name }} ·
        {{ props.group.memberCount }} 位成员
        <span
          class="realtime-indicator"
          :class="realtimeConnection"
          data-testid="realtime-status"
          aria-live="polite"
          >{{ realtimeLabel }}</span
        >
      </div>
      <div class="header-actions">
        <span class="account-name">{{ props.user.name }}</span>
        <button
          :disabled="(locked || resourceBusy) && !unavailable"
          @click="leaveWorkspace('leave')"
        >
          切换群组
        </button>
        <button
          :disabled="(locked || resourceBusy) && !unavailable"
          @click="leaveWorkspace('logout')"
        >
          退出登录
        </button>
      </div>
    </header>
    <main>
      <div class="page-heading">
        <div>
          <p class="eyebrow">IMAGE REVIEW / 图片审核</p>
          <h1>每一处问题，都有迹可循<span>。</span></h1>
          <p class="subtitle">
            点击图片落下标记，写下说明，与同事对齐每一个细节。
          </p>
        </div>
        <button
          class="upload-btn"
          :disabled="locked || resourceBusy || unavailable"
          @click="uploadInput?.click()"
        >
          ＋ {{ uploading ? "处理图片中…" : "上传图片" }}</button
        ><input
          ref="uploadInput"
          class="hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          @change="upload"
        />
      </div>
      <section class="workspace" aria-label="图片审核工作区">
        <div class="workspace-top">
          <div class="image-picker">
            <span class="folder-icon">▧</span
            ><select
              aria-label="图片选择"
              :value="current?.image.id"
              :disabled="locked || resourceBusy"
              @change="imageChange"
            >
              <option v-for="im in images" :key="im.id" :value="im.id">
                {{ im.title }}
              </option></select
            ><span class="dimension"
              >{{ current?.image.width }} × {{ current?.image.height }} px</span
            >
          </div>
          <div class="save-actions">
            <button
              v-if="canDeletePhoto"
              class="danger-action"
              :disabled="locked || resourceBusy || !!pending || unavailable"
              @click="deletePhoto"
            >
              {{ deleting ? "删除中…" : "删除照片" }}
            </button>
            <span class="save-state" :class="status" role="status"
              ><i></i>{{ statusText }}</span
            ><button
              class="primary"
              :disabled="
                !dirty ||
                locked ||
                status === 'conflict' ||
                resourceBusy ||
                unavailable
              "
              @click="r.save()"
            >
              {{ status === "saving" ? "保存中…" : "保存标注" }} <kbd>⌘ S</kbd>
            </button>
          </div>
        </div>
        <div v-if="message" class="notice" :class="status" role="alert">
          <span>{{ message }}</span
          ><button v-if="status === 'unconfirmed'" @click="r.reconcile()">
            重新核对结果</button
          ><template v-if="status === 'conflict'"
            ><button @click="copyDraft">复制本地说明</button
            ><button @click="reloadLatest">加载最新版本</button></template
          >
        </div>

        <div
          v-if="syncError"
          class="notice realtime-warning"
          data-testid="sync-warning"
          aria-live="polite"
        >
          <span>{{ syncError }}</span>
          <button v-if="unavailable && dirty" @click="copyDraft">
            复制本地说明
          </button>
        </div>
        <div
          v-if="remoteChanges.length"
          class="remote-updates"
          data-testid="remote-updates"
          aria-live="polite"
        >
          <strong>这张图片已被其他人更新</strong>
          <p>
            你的未保存内容和原编辑版本已保留。以下为最新共享变动，保存时会合并；同一标记的不同内容将分别保留。
          </p>
          <ul>
            <li v-for="change in remoteChanges" :key="change.id">
              <span>{{ change.label }}</span>
              <p>{{ change.deleted ? "已删除：" : "" }}{{ change.content }}</p>
            </li>
          </ul>
        </div>

        <div
          class="backup-bar"
          :class="{ failed: backupStatus === 'error' }"
          data-testid="backup-status"
          aria-live="polite"
        >
          <span>{{ backupLabel }}</span
          ><span v-if="backupError">{{ backupError }}</span
          ><button
            v-if="backupStatus === 'error'"
            @click="r.flushBackup()"
            :disabled="!!recoveries.length"
          >
            重试备份</button
          ><small>草稿备份仅自己可见，不等于已保存组内标注</small>
        </div>
        <div
          v-if="recoveries.length"
          class="recovery-panel"
          data-testid="draft-recovery"
        >
          <div>
            <strong>发现 {{ recoveries.length }} 份未保存草稿</strong>
            <p>可恢复最近成功备份的内容，包括空说明和未完成标记。</p>
          </div>
          <select v-model="recoveryId" aria-label="选择恢复草稿">
            <option v-for="item in recoveries" :key="item.id" :value="item.id">
              {{ new Date(item.updatedAt).toLocaleString("zh-CN") }} ·
              {{ item.annotations.length }} 个标记
            </option>
          </select>
          <button
            class="primary"
            :disabled="backupAction"
            @click="restoreFoundDraft"
          >
            恢复草稿</button
          ><button :disabled="backupAction" @click="discardFoundDrafts">
            放弃备份
          </button>
        </div>
        <div class="workspace-body">
          <section class="canvas-column">
            <div class="canvas-tools">
              <div class="zoom-controls">
                <button
                  v-for="z in [
                    { v: 'fit', t: '适应宽度' },
                    { v: '0.5', t: '50%' },
                    { v: '1', t: '100%' },
                    { v: '2', t: '200%' },
                  ]"
                  :key="z.v"
                  :class="{ active: zoom === z.v }"
                  @click="setZoom(z.v)"
                >
                  {{ z.t }}
                </button>
              </div>
              <span
                class="canvas-hint"
                title="滚轮或双指滑动移动图片；Shift+滚轮或双指捏合缩放。"
                ><span>⌖</span> 滚轮移动 · Shift+滚轮 / 捏合缩放</span
              >
            </div>
            <div ref="viewport" class="viewport" data-testid="viewport">
              <div
                v-if="current"
                :key="current.image.id"
                class="image-stage"
                :style="{
                  width: `${current.image.width * scale}px`,
                  height: `${current.image.height * scale}px`,
                }"
                ref="plane"
                data-testid="image-plane"
                @click="addPin"
              >
                <img
                  :key="current.image.id"
                  :src="`/api/images/${current.image.id}/content`"
                  alt="待审核图片，点击问题位置添加标记"
                  draggable="false"
                  @load="imageReady = true"
                  @error="
                    imageReady = false;
                    message = '图片加载失败，请刷新重试';
                  "
                />
                <button
                  v-for="(a, i) in draft"
                  :id="`pin-${a.id}`"
                  :key="a.id"
                  class="pin"
                  :class="{ selected: selected === a.id }"
                  :style="{
                    left: `${a.x * 100}%`,
                    top: `${a.y * 100}%`,
                    marginLeft: `${draft.slice(0, i).filter((other) => other.x === a.x && other.y === a.y).length * 32}px`,
                  }"
                  :title="`标记 ${i + 1}：${a.content}（同位置标记并排显示，实际坐标不变）`"
                  :aria-label="`标记 ${i + 1}`"
                  @click.stop="selectPin(a.id)"
                >
                  <span>{{ i + 1 }}</span>
                </button>
              </div>
              <div v-else class="empty-canvas">
                {{
                  loading ? "正在打开图片…" : "暂无图片，请上传或检查服务连接"
                }}
              </div>
            </div>
            <footer class="canvas-footer">
              <span><i class="live-dot"></i> 归一化坐标 · 缩放不偏移</span
              ><span
                >{{ Math.round(scale * 100) }}% ·
                {{ draft.length }} 个标记</span
              >
            </footer>
          </section>
          <aside class="annotation-panel">
            <div class="panel-heading">
              <div>
                <h2>
                  问题标记
                  <span>{{ draft.length.toString().padStart(2, "0") }}</span>
                </h2>
                <p>把反馈留在它发生的位置</p>
              </div>
              <span class="list-icon">☷</span>
            </div>
            <div class="annotation-list">
              <div v-if="!draft.length" class="empty-list">
                <span>⌖</span>
                <h3>从第一个标记开始</h3>
                <p>点击左侧图片的问题位置，<br />然后在这里补充说明。</p>
                <div class="steps">01 落点　 →　02 说明　 →　03 保存</div>
              </div>
              <button
                v-for="(a, i) in draft"
                :key="a.id"
                class="annotation-card"
                :class="{ active: selected === a.id }"
                @click="selectPin(a.id, true)"
              >
                <span class="number">{{ i + 1 }}</span>
                <div>
                  <strong>{{ a.content || "等待填写问题说明" }}</strong
                  ><small
                    >{{
                      a.createdByName ||
                      operators.find((o) => o.id === a.createdBy)?.name ||
                      "本地草稿"
                    }}
                    <span v-if="a.updatedBy && a.updatedBy !== a.createdBy">
                      ·
                      {{
                        a.updatedByName ||
                        operators.find((o) => o.id === a.updatedBy)?.name ||
                        "群组成员"
                      }}
                      修改
                    </span>
                    ·
                    {{
                      a.updatedAt
                        ? new Date(a.updatedAt).toLocaleString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "尚未保存"
                    }}</small
                  >
                </div>
                <span class="card-arrow">↗</span>
              </button>
            </div>
            <div v-if="selectedItem" class="editor">
              <label for="annotation-content"
                >标记 {{ draft.findIndex((a) => a.id === selected) + 1 }} ·
                问题说明</label
              ><textarea
                id="annotation-content"
                ref="editor"
                v-model="selectedItem.content"
                :disabled="!canEdit"
                placeholder="例如：活动价格与页面文案不一致…"
                aria-describedby="editor-shortcuts"
                @input="r.edit()"
                @keydown="editorKeydown"
              ></textarea>
              <div class="editor-bottom">
                <button
                  class="delete-btn"
                  aria-keyshortcuts="Delete Backspace"
                  title="快捷键：Delete / ⌫（输入文字时除外）"
                  :disabled="!canEdit"
                  @click="deletePin"
                >
                  删除标记</button
                ><span
                  :class="{
                    invalid:
                      contentLength(selectedItem.content) > 500 ||
                      contentLength(selectedItem.content) === 0,
                  }"
                  >{{ contentLength(selectedItem.content) }} / 500</span
                >
              </div>
              <p id="editor-shortcuts" class="field-hint">
                Enter 保存 · Shift＋Enter
                换行。未完成标记自动备份，注意上方备份状态。
              </p>
            </div>
            <div v-else class="panel-note">
              <span>ⓘ</span>
              <p>
                支持添加、编辑和删除标记。<br />每张图片最多 100 个，说明最多
                500 字。
              </p>
            </div>
          </aside>
        </div>
      </section>
      <div class="bottom-note">
        <span>PNG / JPEG / 静态 WebP · 最大 10MiB · 2000万像素</span
        ><span>审图台 / 为清晰的反馈而设计</span>
      </div>
    </main>
    <div v-if="pending" class="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-title"
        class="modal"
      >
        <span class="modal-icon">↗</span>
        <h2 id="switch-title">还有未保存的修改</h2>
        <p>是否先保存当前修改，再切换图片？放弃修改将恢复上次保存的内容。</p>
        <div>
          <button @click="r.resolveSwitch('cancel')" :disabled="locked">
            取消</button
          ><button @click="r.resolveSwitch('discard')" :disabled="locked">
            放弃修改</button
          ><button
            class="primary"
            @click="r.resolveSwitch('save')"
            :disabled="locked || status === 'conflict'"
          >
            保存后切换
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
