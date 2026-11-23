/**
 * 上游读超时守卫（防上游僵死把 /v1 并发票占死）。
 *
 * 背景：/v1 代理的并发票（conc）只在响应结束（res 'close'/'finish'）时释放。
 * 若上游（vLLM / Strata 等）冷启动或中途僵死，fetch()/reader.read() 会一直挂着，
 * 响应永不结束 → 并发槽被永久占死 → 之后所有调用者一律 429「并发已满」。
 *
 * 这里给上游读加“看门狗”：超时即 abort，正在 await 的 fetch/reader 立刻抛错，
 * 调用方走上游错误分支 → 响应结束 → 槽释放。三个阶段分别可调（env）：
 *   - 首包（响应头）超时   SSEAPI_UPSTREAM_HEADER_TIMEOUT_MS（默认 120000）
 *   - 非流式整体超时        SSEAPI_UPSTREAM_BODY_TIMEOUT_MS  （默认 300000）
 *   - 流式块间空闲超时      SSEAPI_UPSTREAM_STREAM_IDLE_TIMEOUT_MS（默认 120000）
 */
function envMs(key: string, def: number): number {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : def
}

export const UPSTREAM_HEADER_TIMEOUT_MS = envMs('SSEAPI_UPSTREAM_HEADER_TIMEOUT_MS', 120_000)
export const UPSTREAM_BODY_TIMEOUT_MS = envMs('SSEAPI_UPSTREAM_BODY_TIMEOUT_MS', 300_000)
export const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = envMs('SSEAPI_UPSTREAM_STREAM_IDLE_TIMEOUT_MS', 120_000)

export class UpstreamTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamTimeoutError'
  }
}

export type UpstreamWatchdog = {
  /** 传给 fetch 的 abort signal */
  signal: AbortSignal
  /** 响应头已到 → 切到非流式“整体读取”超时 */
  armBody: () => void
  /** 流式每读到一块 → 重置“块间空闲”计时 */
  armIdle: () => void
  /** 响应已结束 → 清除计时器（幂等） */
  stop: () => void
}

/**
 * 创建一个上游读超时看门狗。初始计时为首包（响应头）超时；
 * 把返回的 signal 传给 fetch 即可；读到响应头后按流式/非流式切换计时。
 */
export function upstreamWatchdog(opts?: {
  headerMs?: number
  bodyMs?: number
  idleMs?: number
}): UpstreamWatchdog {
  const headerMs = opts?.headerMs ?? UPSTREAM_HEADER_TIMEOUT_MS
  const bodyMs = opts?.bodyMs ?? UPSTREAM_BODY_TIMEOUT_MS
  const idleMs = opts?.idleMs ?? UPSTREAM_STREAM_IDLE_TIMEOUT_MS
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (ms: number, what: string) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => ac.abort(new UpstreamTimeoutError(`上游${what}超过 ${ms}ms`)), ms)
    // 看门狗不该把事件循环钉住
    ;(timer as { unref?: () => void }).unref?.()
  }
  arm(headerMs, '首包响应')
  return {
    signal: ac.signal,
    armBody: () => arm(bodyMs, '整体响应'),
    armIdle: () => arm(idleMs, '流式空闲'),
    stop: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
