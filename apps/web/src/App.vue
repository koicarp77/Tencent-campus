<script setup lang="ts">
import { onMounted, ref } from "vue";
import ReviewWorkspace from "./ReviewWorkspace.vue";
import { request, HttpError } from "./api";
import type {
  Account,
  GroupInfo,
} from "../../../packages/shared/src/contracts";
const user = ref<Account | null>(null),
  currentGroup = ref<GroupInfo | null>(null),
  booting = ref(true),
  busy = ref(false),
  searching = ref(false);
const mode = ref<"login" | "register">("login"),
  accountName = ref(""),
  error = ref(""),
  search = ref(""),
  groupName = ref(""),
  groups = ref<GroupInfo[]>([]);
let searchVersion = 0;
const explain = (e: unknown) => (e instanceof Error ? e.message : String(e));
function routeGroup(id?: string) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("group", id);
  else url.searchParams.delete("group");
  url.searchParams.delete("image");
  history.replaceState(null, "", url);
}
async function loadGroups() {
  const version = ++searchVersion;
  searching.value = true;
  try {
    const result = await request<GroupInfo[]>(
      `/api/groups?search=${encodeURIComponent(search.value)}`,
    );
    if (version === searchVersion) groups.value = result;
  } catch (e) {
    if (version === searchVersion) error.value = explain(e);
  } finally {
    if (version === searchVersion) searching.value = false;
  }
}
async function bootstrap() {
  booting.value = true;
  error.value = "";
  try {
    user.value = (
      await request<{ user: Account | null }>("/api/auth/session")
    ).user;
    if (user.value) {
      const id = new URLSearchParams(location.search).get("group");
      if (id) {
        try {
          currentGroup.value = await request<GroupInfo>(
            `/api/groups/${encodeURIComponent(id)}`,
          );
        } catch (e) {
          error.value = explain(e);
        }
      }
      await loadGroups();
    }
  } catch (e) {
    error.value = explain(e);
  } finally {
    booting.value = false;
  }
}
async function authenticate() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const response = await request<{ user: Account }>(
      `/api/auth/${mode.value}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName.value }),
      },
    );
    user.value = response.user;
    currentGroup.value = null;
    routeGroup();
    search.value = "";
    await loadGroups();
  } catch (e) {
    error.value = explain(e);
  } finally {
    busy.value = false;
  }
}
async function enter(group: GroupInfo) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = group.joined
      ? await request<GroupInfo>(`/api/groups/${group.id}`)
      : await request<GroupInfo>(`/api/groups/${group.id}/join`, {
          method: "POST",
        });
    routeGroup(result.id);
    currentGroup.value = result;
  } catch (e) {
    error.value = explain(e);
  } finally {
    busy.value = false;
  }
}
async function create() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await request<GroupInfo>("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: groupName.value }),
    });
    groupName.value = "";
    routeGroup(result.id);
    currentGroup.value = result;
  } catch (e) {
    error.value = explain(e);
  } finally {
    busy.value = false;
  }
}
async function removeGroup(group: GroupInfo) {
  if (busy.value || group.createdBy !== user.value?.id) return;
  if (
    !window.confirm(
      `删除群组「${group.name}」？群组内所有照片及标记将一并永久删除（包括草稿备份），无法恢复；成员账号不会被删除。`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    try {
      await request(`/api/groups/${group.id}`, { method: "DELETE" });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        /* Already removed. */
      } else if (!(e instanceof HttpError)) {
        let gone = false;
        try {
          await request(`/api/groups/${group.id}`);
        } catch (check) {
          gone = check instanceof HttpError && check.status === 404;
        }
        if (!gone)
          throw new Error(
            "删除结果尚未确认，请重新搜索群组确认后再决定是否重试。",
          );
      } else throw e;
    }
    await loadGroups();
  } catch (e) {
    error.value = explain(e);
  } finally {
    busy.value = false;
  }
}
async function leave() {
  currentGroup.value = null;
  routeGroup();
  error.value = "";
  await loadGroups();
}
async function logout() {
  busy.value = true;
  error.value = "";
  try {
    await request("/api/auth/logout", { method: "POST" });
    currentGroup.value = null;
    user.value = null;
    accountName.value = "";
    routeGroup();
  } catch (e) {
    error.value = explain(e);
  } finally {
    busy.value = false;
  }
}
onMounted(bootstrap);
</script>
<template>
  <div v-if="booting" class="session-loading" role="status">
    正在打开工作空间…
  </div>
  <template v-else-if="currentGroup && user">
    <div v-if="error" class="notice" role="alert">{{ error }}</div>
    <ReviewWorkspace
      :key="`${user.id}:${currentGroup.id}`"
      :user="user"
      :group="currentGroup"
      @leave="leave"
      @logout="logout"
    />
  </template>
  <main v-else-if="!user" class="auth-page">
    <section class="auth-story">
      <a class="brand" href="/">⌖ 审图台</a>
      <p class="eyebrow">REVIEW TOGETHER</p>
      <h1>一起看见问题，<br />让每次反馈<br />都有落点<span>。</span></h1>
      <p>
        加入一个群组，上传图片、留下标记。<br />让团队在同一张图上对齐细节。
      </p>
      <div class="auth-art">
        <span>01</span>
        <div></div>
        <span>02</span>
        <div></div>
        <span>03</span>
      </div>
      <small>一个账号名，连接你的协作空间。</small>
    </section>
    <section class="auth-card">
      <p class="eyebrow">YOUR WORKSPACE / 你的工作空间</p>
      <h2>{{ mode === "login" ? "欢迎回来" : "创建你的账号" }}</h2>
      <p class="muted">仅凭账号名登录，无需密码。</p>
      <div class="auth-tabs" role="tablist" aria-label="账号入口">
        <button
          role="tab"
          :aria-selected="mode === 'login'"
          :class="{ active: mode === 'login' }"
          @click="
            mode = 'login';
            error = '';
          "
          :disabled="busy"
        >
          登录</button
        ><button
          role="tab"
          :aria-selected="mode === 'register'"
          :class="{ active: mode === 'register' }"
          @click="
            mode = 'register';
            error = '';
          "
          :disabled="busy"
        >
          注册
        </button>
      </div>
      <form @submit.prevent="authenticate">
        <label for="account-name">账号名</label
        ><input
          id="account-name"
          v-model="accountName"
          autocomplete="username"
          placeholder="输入你的账号名"
          :disabled="busy"
          required
          maxlength="64"
        />
        <p class="field-hint">1—32个字符；忽略首尾空格、全半角及大小写差异。</p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary" :disabled="busy || !accountName.trim()">
          {{
            busy ? "请稍候…" : mode === "login" ? "登录并进入" : "注册并登录"
          }}
          <span>↗</span>
        </button>
      </form>
      <p class="auth-switch">
        {{ mode === "login" ? "还没有账号？" : "已经有账号？"
        }}<button
          @click="
            mode = mode === 'login' ? 'register' : 'login';
            error = '';
          "
          :disabled="busy"
        >
          {{ mode === "login" ? "去注册" : "去登录" }}
        </button>
      </p>
      <p class="auth-demo">首次体验可用已有演示账号「小林」或「小周」登录。</p>
    </section>
  </main>
  <div v-else class="group-shell">
    <header class="topbar">
      <a class="brand" href="/">⌖ 审图台 <small>REVIEW DESK</small></a
      ><span class="project-label">群组工作空间</span>
      <div class="header-actions">
        <span class="account-name">{{ user.name }}</span
        ><button @click="logout" :disabled="busy">退出登录</button>
      </div>
    </header>
    <main class="group-main">
      <div class="page-heading">
        <div>
          <p class="eyebrow">TEAM SPACES / 协作群组</p>
          <h1>找到同伴，开始审图<span>。</span></h1>
          <p class="subtitle">
            群组内共享图片和标记。搜索后可直接加入，无需审批。
          </p>
        </div>
      </div>
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <div class="group-layout">
        <section class="group-browser">
          <form
            class="group-search"
            @submit.prevent="
              error = '';
              loadGroups();
            "
          >
            <label for="group-search" class="sr-only">搜索群组</label
            ><input
              id="group-search"
              v-model="search"
              placeholder="按群组名字搜索…"
              maxlength="100"
            /><button class="primary" :disabled="searching">
              {{ searching ? "搜索中…" : "搜索群组" }}
            </button>
          </form>
          <div class="group-list-heading">
            <h2>{{ search ? "搜索结果" : "可加入的群组" }}</h2>
            <span>最多显示100个结果</span>
          </div>
          <div class="group-grid">
            <article v-for="group in groups" :key="group.id" class="group-card">
              <div class="group-card-top">
                <span class="group-symbol">⌘</span
                ><span class="membership" :class="{ joined: group.joined }">{{
                  group.joined ? "已加入" : "开放加入"
                }}</span>
              </div>
              <h3>{{ group.name }}</h3>
              <p>{{ group.memberCount }} 位成员 · 图片与标记共享</p>
              <button :disabled="busy" @click="enter(group)">
                {{ group.joined ? "进入群组" : "加入并进入" }} <span>↗</span>
              </button>
              <button
                v-if="group.createdBy === user.id"
                class="danger-action group-delete"
                :disabled="busy"
                @click="removeGroup(group)"
              >
                删除群组
              </button>
              <p v-if="group.createdBy === null" class="system-group-note">
                系统群组，不能删除
              </p>
            </article>
          </div>
          <div v-if="!searching && !groups.length" class="group-empty">
            没有找到群组，可以换个名字搜索，或创建一个新群组。
          </div>
        </section>
        <aside class="create-group">
          <span class="eyebrow">START SOMETHING / 开始协作</span>
          <h2>创建新群组</h2>
          <p>为你的项目留一个共同的审图空间。每个人都可以创建或加入群组。</p>
          <form @submit.prevent="create">
            <label for="group-name">群组名字</label
            ><input
              id="group-name"
              v-model="groupName"
              required
              placeholder="例如：秋季海报审核"
              maxlength="100"
              :disabled="busy"
            />
            <p class="field-hint">1—50个字符，名字唯一。</p>
            <button class="primary" :disabled="busy || !groupName.trim()">
              创建并进入 ＋
            </button>
          </form>
          <div class="group-tip">
            群组内所有成员均可上传图片、编辑和保存标记。
          </div>
        </aside>
      </div>
    </main>
  </div>
</template>
