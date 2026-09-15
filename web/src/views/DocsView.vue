<template>
  <div class="card panel redirect">
    <h1 class="page-title">文档</h1>
    <p class="page-sub">正在打开外部文档（iWiki）…</p>
    <p v-if="error" class="err">{{ error }}</p>
    <a v-if="url" class="btn btn-primary" :href="url" target="_blank" rel="noopener noreferrer">
      若未自动跳转，点此打开
    </a>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import { setDocsLink } from '../store/docs'

const url = ref('https://ssemarket.cn/iwiki/space/space-R0M8mXw2')
const error = ref('')

onMounted(async () => {
  try {
    const d = await api.docs()
    url.value = d.url
    setDocsLink({ title: d.title, url: d.url })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  window.open(url.value, '_blank', 'noopener,noreferrer')
})
</script>

<style scoped>
.redirect {
  padding: var(--sp-6);
  max-width: 500px;
}
.redirect .page-sub {
  margin-bottom: var(--sp-4);
}
.err {
  color: var(--danger-ink);
  font-size: var(--fs-base);
  margin: 0 0 var(--sp-2);
}
.btn {
  margin-top: var(--sp-2);
}
</style>
