/** 解析允许域名列表：逗号 / 换行 / 分号分隔 */
export function parseOriginList(raw: string | undefined | null): string[] {
  if (!raw) return []
  return String(raw)
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function normalizeHost(input: string): string {
  let s = input.trim().toLowerCase()
  if (!s) return ''
  try {
    if (s.includes('://')) {
      const u = new URL(s)
      return u.host
    }
  } catch {
    /* ignore */
  }
  // 去掉路径
  s = s.split('/')[0] || s
  return s.replace(/^\*\./, '*.')
}

function hostMatches(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern)
  const h = normalizeHost(host)
  if (!p || !h) return false
  if (p === h) return true
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // .example.com
    return h.endsWith(suffix) || h === p.slice(2)
  }
  return false
}

/**
 * 检查请求 Origin / Referer 是否命中白名单。
 * - 白名单为空：不限制
 * - 有 Origin 或 Referer：必须命中其一
 * - 均无（典型服务端 curl）：放行（服务端调用）
 */
export function checkAllowedOrigins(
  allowedRaw: string | undefined | null,
  originHeader: string | undefined,
  refererHeader: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  const list = parseOriginList(allowedRaw)
  if (!list.length) return { ok: true }

  const candidates: string[] = []
  if (originHeader) candidates.push(originHeader)
  if (refererHeader) {
    try {
      candidates.push(new URL(refererHeader).origin)
    } catch {
      candidates.push(refererHeader)
    }
  }

  if (!candidates.length) {
    // 无浏览器来源头：视为服务端调用
    return { ok: true }
  }

  for (const c of candidates) {
    if (list.some((p) => hostMatches(p, c))) return { ok: true }
  }
  return { ok: false, reason: `来源未授权：${candidates[0]}` }
}

/** 合并多条白名单字符串 */
export function mergeOriginLists(...raws: (string | undefined | null)[]): string {
  const set = new Set<string>()
  for (const r of raws) {
    for (const x of parseOriginList(r)) set.add(x)
  }
  return [...set].join('\n')
}
