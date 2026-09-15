import { reactive } from 'vue'
import { api } from '../api'

/** 侧栏/快捷入口共用的外部文档链接 */
export const docsLink = reactive({
  title: '文档',
  url: 'https://ssemarket.cn/iwiki/space/space-R0M8mXw2',
  loaded: false,
})

export function setDocsLink(partial: { title?: string; url?: string }) {
  if (partial.title) docsLink.title = partial.title
  if (partial.url) docsLink.url = partial.url
  docsLink.loaded = true
}

export async function openDocs() {
  if (!docsLink.loaded) {
    try {
      const d = await api.docs()
      setDocsLink({ title: d.title, url: d.url })
    } catch {
      /* keep default */
    }
  }
  const url = docsLink.url || 'https://ssemarket.cn/iwiki/space/space-R0M8mXw2'
  window.open(url, '_blank', 'noopener,noreferrer')
}
