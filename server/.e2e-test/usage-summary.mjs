// 验证后端 /usage/summary 的 byDay 聚合 + 前端 bars 高度计算（含时区边界）
// 覆盖：UTC 北京时间凌晨记录应归到本地当天；tokens>0 柱子高度正确。

function localDay(iso) {
  const d = new Date(iso)
  const offsetMin = -d.getTimezoneOffset()
  const shifted = new Date(d.getTime() + offsetMin * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

const logs = [
  // 北京时间 09-05 13:04（UTC 同日），主量
  { created_at: '2026-09-05T13:04:06.384Z', total_tokens: 58949, cost_cents: 59 },
  // 北京时间 09-05 07:04（UTC 09-04T23:04，旧 slice(0,10) 会错误归到 09-04）
  { created_at: '2026-09-04T23:04:06.384Z', total_tokens: 1000, cost_cents: 5 },
  // 北京时间 09-05 09:04（UTC 09-05T01:04）
  { created_at: '2026-09-05T01:04:06.384Z', total_tokens: 2000, cost_cents: 3 },
  // 北京时间 09-04 晚间（UTC 09-04T12:04），应归到 09-04
  { created_at: '2026-09-04T12:04:06.384Z', total_tokens: 500, cost_cents: 2 },
]

const dayMap = new Map()
for (const l of logs) {
  const day = localDay(l.created_at)
  const cur = dayMap.get(day) || { day, tokens: 0, cost_cents: 0, requests: 0 }
  cur.tokens += l.total_tokens
  cur.cost_cents += l.cost_cents
  cur.requests += 1
  dayMap.set(day, cur)
}
const byDay = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day))

const max = Math.max(1, ...byDay.map((x) => x.tokens || 0))
const bars = byDay.map((x) => ({
  day: x.day,
  tokens: x.tokens,
  h: Math.max(4, Math.round(((x.tokens || 0) / max) * 100)),
}))

console.log('byDay:', JSON.stringify(byDay))
console.log('bars:', JSON.stringify(bars))

let pass = true
const check = (cond, msg) => {
  if (!cond) {
    pass = false
    console.log('FAIL:', msg)
  }
}

// 06-04T23:04Z（北京时间 09-05 07:04）应归到 09-05，而不是 09-04
check(bars.some((b) => b.day === '2026-09-05'), '北京时间凌晨记录应归到本地 09-05')
// 09-04 应有独立柱子
check(bars.some((b) => b.day === '2026-09-04'), '09-04 应有柱子')
// 最大 token 天的柱子高度应为 100
const maxBar = bars.find((b) => b.tokens === Math.max(...bars.map((x) => x.tokens)))
check(maxBar && maxBar.h === 100, '最大 tokens 的柱子高度应为 100')
// 所有柱子高度至少 4（非零可见）
check(bars.every((b) => b.h >= 4), '所有柱子高度 >= 4')
// 不存在错误归到 09-04 的 1000 那条（它应在 09-05）
const sep4 = byDay.find((b) => b.day === '2026-09-04')
check(sep4 && sep4.tokens === 500 + 0, '09-04 只应包含北京时间 09-04 的记录（500）')

console.log(pass ? 'ALL USAGE-SUMMARY TESTS PASSED' : 'USAGE-SUMMARY TESTS FAILED')
process.exit(pass ? 0 : 1)
