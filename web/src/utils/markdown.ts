// 极简 Markdown 渲染器（无依赖）。
// 输出给 v-html 用 ⇒ 必须**先转义 HTML 再拼标签**，模型输出里的 <script> 不能进 DOM。
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c])
}

/** 行内元素：code / 粗体 / 斜体 / 链接 */
function inline(src: string): string {
  let out = esc(src)
  out = out.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  )
  return out
}

/** 块级元素：标题、有序/无序列表、段落 */
function blocks(text: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) {
      closeList()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) {
      closeList()
      const lv = h[1].length
      out.push(`<div class="md-h md-h${lv}">${inline(h[2])}</div>`)
      continue
    }
    const ul = /^[-*+]\s+(.*)$/.exec(t)
    if (ul) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(ul[1])}</li>`)
      continue
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(t)
    if (ol) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(ol[1])}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(t)}</p>`)
  }
  closeList()
  return out.join('')
}

export function renderMarkdown(text: string): string {
  const src = String(text ?? '')
  let html = ''
  const parts = src.split('```')
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // ```lang\ncode… 语言标注只用于显示
      const nl = part.indexOf('\n')
      const lang = nl >= 0 ? part.slice(0, nl).trim() : ''
      const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '')
      const attr = lang ? ` data-lang="${esc(lang)}"` : ''
      html += `<pre class="md-pre"><code${attr}>${esc(code)}</code></pre>`
    } else {
      html += blocks(part)
    }
  })
  return html
}
