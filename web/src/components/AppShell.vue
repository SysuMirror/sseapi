<template>
  <div class="shell">
    <aside class="side">
      <div class="brand">
        <img class="logo-mark" src="https://image.ssemarket.cn/i/images/2026/08/26/6420979e-abce-4fc6-9034-bcb86340ee59.png" alt="SSE Market" width="36" height="36" />
        <div>
          <div class="brand-name">SSE_Market</div>
          <div class="brand-tag">API 开发平台</div>
        </div>
      </div>

      <nav class="nav">
        <RouterLink
          v-for="item in userNav"
          :key="item.to"
          :to="item.to"
          class="nav-item"
        >
          <span class="nav-icon" v-html="item.icon" />
          {{ item.label }}
        </RouterLink>

        <a
          class="nav-item"
          :href="docsLink.url"
          target="_blank"
          rel="noopener noreferrer"
          @click="ensureDocsLoaded"
        >
          <span class="nav-icon" v-html="icons.docs" />
          文档
          <span class="ext-mark" aria-hidden="true">↗</span>
        </a>

        <template v-if="auth.user?.isAdmin">
          <div class="nav-section">管理</div>
          <RouterLink to="/admin" class="nav-item">
            <span class="nav-icon" v-html="icons.admin" />
            管理台
          </RouterLink>
        </template>
      </nav>

      <div class="side-foot">
        <div class="user-row">
          <img
            v-if="avatarUrl && !avatarBroken"
            class="avatar avatar-img"
            :src="avatarUrl"
            alt=""
            referrerpolicy="no-referrer"
            @error="avatarBroken = true"
          />
          <div v-else class="avatar">{{ initials }}</div>
          <div class="user-meta">
            <div class="user-name">{{ auth.user?.name }}</div>
            <div class="user-bal mono">¥{{ balanceYuan }}</div>
          </div>
        </div>
        <button class="btn btn-ghost logout" type="button" @click="logout">退出</button>
      </div>
    </aside>

    <main class="main">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { auth, clearAuth, patchUser } from '../store/auth'
import { docsLink, setDocsLink } from '../store/docs'
import { api } from '../api'

const router = useRouter()
const avatarBroken = ref(false)

const icons = {
  overview:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  keys: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="15" r="4"/><path d="M12 15h9M18 12v6"/></svg>',
  usage:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6"/></svg>',
  billing:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  models:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
  docs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/></svg>',
  admin:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
}

const userNav = [
  { to: '/', label: '概览', icon: icons.overview },
  { to: '/keys', label: 'API 密钥', icon: icons.keys },
  { to: '/usage', label: '用量', icon: icons.usage },
  { to: '/billing', label: '余额与流水', icon: icons.billing },
  { to: '/models', label: '模型', icon: icons.models },
]

const initials = computed(() => (auth.user?.name || '?').slice(0, 1).toUpperCase())
const balanceYuan = computed(() => ((auth.user?.balanceCents || 0) / 100).toFixed(2))
const avatarUrl = computed(() => String(auth.user?.avatarUrl || '').trim())

watch(avatarUrl, () => {
  avatarBroken.value = false
})

async function loadDocsLink() {
  try {
    const d = await api.docs()
    setDocsLink({ title: d.title, url: d.url })
  } catch {
    /* keep default */
  }
}

function ensureDocsLoaded() {
  if (!docsLink.loaded) void loadDocsLink()
}

onMounted(async () => {
  try {
    const me = await api.me()
    patchUser(me)
  } catch {
    /* handled */
  }
  await loadDocsLink()
})

function logout() {
  clearAuth()
  router.push({ name: 'login' })
}
</script>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  min-height: 100vh;
  background: var(--bg);
}
.side {
  background: var(--sidebar);
  color: var(--sidebar-ink);
  display: flex;
  flex-direction: column;
  padding: var(--sp-4) var(--sp-3) var(--sp-3);
  position: sticky;
  top: 0;
  height: 100vh;
  border-right: 1px solid var(--line);
  z-index: 20;
}
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 6px 8px var(--sp-5);
}
.logo-mark {
  width: 36px;
  height: 36px;
  object-fit: contain;
  display: block;
  flex-shrink: 0;
}
.brand-name {
  color: var(--ink-strong);
  font-weight: 680;
  font-size: 15px;
  letter-spacing: -0.025em;
  line-height: 1.2;
}
.brand-tag {
  margin-top: 3px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--ink-faint);
  letter-spacing: 0.01em;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  overflow-y: auto;
  padding-bottom: var(--sp-3);
}
.nav-section {
  margin: var(--sp-4) 10px 6px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--ink-faint);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  color: var(--sidebar-ink);
  font-size: var(--fs-base);
  font-weight: 550;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  outline: none;
}
.nav-item:hover {
  background: var(--sidebar-hover);
  color: var(--ink);
}
.nav-item:focus,
.nav-item:focus-visible {
  outline: none;
  box-shadow: none;
}
.nav-item.router-link-active {
  background: var(--sidebar-active-bg);
  color: var(--sidebar-active);
  font-weight: 600;
}
.nav-item.router-link-active::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
}
.nav-item.router-link-active .nav-icon {
  opacity: 1;
  color: var(--sidebar-active);
}
.nav-icon {
  display: inline-flex;
  opacity: 0.7;
  transition: opacity var(--dur) var(--ease);
}
.nav-item:hover .nav-icon {
  opacity: 1;
}
.ext-mark {
  margin-left: auto;
  font-size: var(--fs-xs);
  opacity: 0.4;
}
.side-foot {
  border-top: 1px solid var(--line);
  padding-top: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.user-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 4px 6px;
}
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-ink);
  display: grid;
  place-items: center;
  font-weight: 650;
  font-size: var(--fs-base);
  flex-shrink: 0;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(51, 112, 255, 0.12);
}
.avatar-img {
  object-fit: cover;
  display: block;
  background: var(--line);
}
.user-meta {
  min-width: 0;
}
.user-name {
  color: var(--ink-strong);
  font-size: var(--fs-base);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-bal {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.logout {
  color: var(--ink) !important;
  border-color: var(--line-strong) !important;
  background: var(--n-0) !important;
  width: 100%;
}
.logout:hover {
  background: var(--sidebar-hover) !important;
}
.main {
  padding: var(--sp-8) var(--sp-8) 72px;
  max-width: 1180px;
  width: 100%;
  animation: fade-up 0.32s var(--ease) both;
}
@media (max-width: 900px) {
  .shell {
    grid-template-columns: 1fr;
  }
  .side {
    position: relative;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }
  .nav {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px;
  }
  .nav-section {
    width: 100%;
    margin: 10px 4px 2px;
  }
  .nav-item.router-link-active::before {
    display: none;
  }
  .main {
    padding: var(--sp-5) var(--sp-4) var(--sp-8);
  }
}
</style>
