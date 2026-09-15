<template>
  <div class="wrap">
    <div class="box">
      <span class="spinner" aria-hidden="true" />
      <p class="msg">{{ message }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import {
  clearOAuthPending,
  consumeRedirect,
  markOAuthPending,
  setAuth,
} from '../store/auth'

const route = useRoute()
const router = useRouter()
const message = ref('正在完成登录…')

onMounted(async () => {
  markOAuthPending()
  try {
    const code = String(route.query.code || '')
    const state = String(route.query.state || '')
    if (!code || !state) throw new Error('缺少授权参数')
    const { session_id } = await api.oauthToken(code, state)
    const { token, user } = await api.oauthUserinfo(session_id)
    setAuth(token, user)
    clearOAuthPending()
    await router.replace(consumeRedirect())
  } catch (e) {
    clearOAuthPending()
    message.value = e instanceof Error ? e.message : '登录失败'
    setTimeout(() => router.replace({ name: 'login' }), 1600)
  }
})
</script>

<style scoped>
.wrap {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
}
.box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
}
.spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2.5px solid var(--n-200);
  border-top-color: var(--brand);
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.msg {
  margin: 0;
  color: var(--ink-soft);
  font-size: var(--fs-md);
}
</style>
