<template>
  <canvas
    ref="cv"
    class="orb"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 旋转的「节点球」装饰：斐波那契均匀球面上的点 + 预计算的近邻连线，
 * 整体绕 Y 轴旋转、按深度给透明度，形成 3D 渐变效果。
 *
 * 刻意保持极轻量：点/线数量固定，连线关系在初始化时算一次
 * （球体刚性旋转，近邻关系不变），单帧只做投影与画线。
 * 遵循 prefers-reduced-motion：只画一帧静态图。
 */
const props = withDefaults(
  defineProps<{
    /** CSS 尺寸（px），实际按 devicePixelRatio 放大 */
    size?: number
    /** 球面点数 */
    points?: number
    /** 旋转速度倍率 */
    speed?: number
    /** 品牌色 "r,g,b" */
    rgb?: string
  }>(),
  { size: 320, points: 96, speed: 1, rgb: '51,112,255' },
)

const cv = ref<HTMLCanvasElement | null>(null)
let raf = 0
let ro: ResizeObserver | null = null
let onVisibility: (() => void) | null = null
let staticOnly = false

type P3 = { x: number; y: number; z: number }

function buildSphere(n: number): P3[] {
  const pts: P3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    pts.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r })
  }
  return pts
}

/** 近邻对：球体刚性旋转，连边集合与时间无关，只需算一次 */
function buildEdges(pts: P3[], maxDist: number): Array<[number, number]> {
  const edges: Array<[number, number]> = []
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x
      const dy = pts[i].y - pts[j].y
      const dz = pts[i].z - pts[j].z
      if (dx * dx + dy * dy + dz * dz <= maxDist * maxDist) edges.push([i, j])
    }
  }
  return edges
}

onMounted(() => {
  const canvas = cv.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  staticOnly = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const pts = buildSphere(props.points)
  const edges = buildEdges(pts, 0.42)

  let dpr = 1
  let w = 0
  let h = 0

  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1)
    w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    canvas.width = w
    canvas.height = h
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (staticOnly) draw(0.6)
  }

  /** progress: 0~1 的相位，仅用于旋转角与呼吸感 */
  const draw = (progress: number) => {
    const cssW = w / dpr
    const cssH = h / dpr
    const cx = cssW / 2
    const cy = cssH / 2
    const radius = Math.min(cssW, cssH) * 0.36

    ctx.clearRect(0, 0, cssW, cssH)

    // 中心柔光
    const glow = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * 1.7)
    glow.addColorStop(0, `rgba(${props.rgb}, 0.16)`)
    glow.addColorStop(0.55, `rgba(${props.rgb}, 0.05)`)
    glow.addColorStop(1, `rgba(${props.rgb}, 0)`)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, radius * 1.7, 0, Math.PI * 2)
    ctx.fill()

    const angle = progress * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const tilt = -0.32
    const cosT = Math.cos(tilt)
    const sinT = Math.sin(tilt)

    // 投影：先绕 Y 轴自转，再绕 X 轴轻微倾斜
    const proj = pts.map((p) => {
      const x1 = p.x * cos - p.z * sin
      const z1 = p.x * sin + p.z * cos
      const y2 = p.y * cosT - z1 * sinT
      const z2 = p.y * sinT + z1 * cosT
      const depth = (z2 + 1) / 2 // 0=远 1=近
      const scale = 0.82 + depth * 0.28
      return { x: cx + x1 * radius * scale, y: cy + y2 * radius * scale, depth }
    })

    // 近邻连线
    ctx.lineWidth = 1
    for (const [i, j] of edges) {
      const a = proj[i]
      const b = proj[j]
      const alpha = 0.05 + ((a.depth + b.depth) / 2) * 0.16
      ctx.strokeStyle = `rgba(${props.rgb}, ${alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // 节点
    for (const p of proj) {
      const r = 0.9 + p.depth * 1.5
      ctx.fillStyle = `rgba(${props.rgb}, ${(0.22 + p.depth * 0.6).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const start = performance.now()
  const loop = (now: number) => {
    const seconds = (now - start) / 1000
    // 一圈约 26s，留一点呼吸节奏
    draw(((seconds * props.speed) / 26) % 1)
    raf = requestAnimationFrame(loop)
  }

  const run = () => {
    if (staticOnly || raf) return
    raf = requestAnimationFrame(loop)
  }
  const stop = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  resize()
  if (staticOnly) draw(0.6)
  else run()

  ro = new ResizeObserver(resize)
  ro.observe(canvas)

  // 标签页不可见时停掉动画，别在后台空转
  onVisibility = () => (document.hidden ? stop() : run())
  document.addEventListener('visibilitychange', onVisibility)
})

// 清理注册在 setup 顶层：比写在 onMounted 里更可靠
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  ro?.disconnect()
  ro = null
  if (onVisibility) document.removeEventListener('visibilitychange', onVisibility)
  onVisibility = null
})
</script>

<style scoped>
.orb {
  display: block;
  pointer-events: none;
}
</style>
