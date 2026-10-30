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
import { point, centerAnchor, clamp } from "./coordinates";
import {
  contentLength,
  type Review,
} from "../../../packages/shared/src/contracts";
import { request } from "./api";
const r = useReview();
const {
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
} = r;
const viewport = ref<HTMLElement>(),
  plane = ref<HTMLElement>(),
  editor = ref<HTMLTextAreaElement>();
const zoom = ref("fit"),
  available = ref(600),
  imageReady = ref(false),
  uploading = ref(false),
  uploadInput = ref<HTMLInputElement>();
const scale = computed(() =>
  current.value
    ? zoom.value === "fit"
      ? Math.min(1, (available.value - 80) / current.value.image.width)
      : Number(zoom.value)
    : 1,
);
const selectedItem = computed(() =>
  draft.value.find((a) => a.id === selected.value),
);
const statusText = computed(
  () =>
    ({
      clean: current.value?.image.revision ? "已保存" : "暂无修改",
      dirty: "有未保存修改",
      saving: "保存中…",
      error: "保存失败",
      unconfirmed: "保存结果尚未确认",
      conflict: "版本冲突",
    })[status.value],
);
const canEdit = computed(
  () => !locked.value && status.value !== "conflict" && !uploading.value,
);
watch(
  () => current.value?.image.id,
  () => {
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
    document
      .getElementById(`pin-${id}`)
      ?.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "smooth",
      });
}
function deletePin() {
  if (selected.value) r.remove(selected.value);
}
async function imageChange(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  await r.switchTo("image", id);
  (e.target as HTMLSelectElement).value = current.value?.image.id || "";
}
async function actorChange(e: Event) {
  await r.switchTo("actor", (e.target as HTMLSelectElement).value);
  (e.target as HTMLSelectElement).value = actor.value;
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
    form.append("actorId", actor.value);
    const result = await request<Review>("/api/images", {
      method: "POST",
      body: form,
    });
    images.value.push(result.image);
    await r.switchTo("image", result.image.id);
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e);
  } finally {
    uploading.value = false;
    input.value = "";
  }
}
async function reloadLatest() {
  if (window.confirm("加载最新版本会放弃本地草稿。确认继续？"))
    await r.load(current.value!.image.id);
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
function shortcut(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    r.save();
  }
}
onMounted(async () => {
  await r.init();
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
  observer?.disconnect();
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("keydown", shortcut);
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="审图台首页"
        ><span class="brand-icon">⌖</span>
        <div>审图台<small>REVIEW DESK</small></div></a
      >
      <div class="project-label">
        <span class="live-dot"></span> 本地工作空间
      </div>
      <div class="header-actions">
        <label class="actor-label"
          >操作人
          <select
            aria-label="操作人"
            :value="actor"
            :disabled="locked || uploading"
            @change="actorChange"
          >
            <option v-for="o in operators" :key="o.id" :value="o.id">
              {{ o.name }}
            </option>
          </select></label
        ><span class="avatar">{{
          operators.find((o) => o.id === actor)?.name.slice(-1)
        }}</span>
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
          :disabled="locked || uploading"
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
              :disabled="locked || uploading"
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
            <span class="save-state" :class="status" role="status"
              ><i></i>{{ statusText }}</span
            ><button
              class="primary"
              :disabled="!dirty || locked || status === 'conflict' || uploading"
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
              <span class="canvas-hint"><span>＋</span> 点击图片添加标记</span>
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
                  :style="{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }"
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
                      operators.find((o) => o.id === a.createdBy)?.name ||
                      "本地草稿"
                    }}
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
                @input="r.edit()"
              ></textarea>
              <div class="editor-bottom">
                <button
                  class="delete-btn"
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
              <p class="field-hint">
                修改暂存于当前页面，点击「保存标注」后生效。
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
        <p>是否先以当前操作人保存，再切换？放弃修改将恢复上次保存的内容。</p>
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
