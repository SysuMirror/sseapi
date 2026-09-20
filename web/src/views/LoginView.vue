<template>
  <div class="login">
    <div class="bg" aria-hidden="true" />
    <div class="grid" aria-hidden="true" />
    <main class="shell">
      <section class="story">
        <div class="brand">
          <TerraMark class="brand-mark" />
          <span>YATERRA</span>
          <b>API CONSOLE</b>
        </div>

        <div class="hero">
          <NetworkArt class="network" />
          <p class="eyebrow">
            <SparklesIcon />
            SSE Market Identity
          </p>
          <h1>
            连接每一次
            <span>可信调用。</span>
          </h1>
          <p class="lead">使用软工集市账号进入控制台，统一管理 API 密钥、模型配额与平台用量。</p>
        </div>

        <p class="status">
          <i />
          platform.ssemarket.cn
          <span>/</span>
          api.ssemarket.cn
        </p>
      </section>

      <section class="panel" aria-labelledby="login-title">
        <div class="mobile-brand">
          <TerraMark class="mobile-mark" />
          <span>YATERRA</span>
        </div>

        <div class="lock" aria-hidden="true">
          <LockIcon />
        </div>
        <h2 id="login-title">欢迎回来</h2>
        <p class="sub">通过软工集市身份认证进入 YatTerra 控制台。</p>

        <button class="cta" type="button" :disabled="loading" @click="goLogin">
          <span class="market-icon">S</span>
          {{ loading ? '正在跳转...' : '软工集市登录' }}
          <ArrowIcon class="arrow" />
        </button>

        <p v-if="error" class="error" role="alert">{{ error }}</p>

        <div class="divider">
          <span />
          安全连接
          <span />
        </div>

        <div class="assurance">
          <p>
            <ShieldIcon />
            OAuth 2.0 授权
          </p>
          <p>
            <KeyIcon />
            不保存账号密码
          </p>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { saveRedirect } from '../store/auth'

const loading = ref(false)
const error = ref('')
const route = useRoute()

async function goLogin() {
  loading.value = true
  error.value = ''
  try {
    if (typeof route.query.redirect === 'string') saveRedirect(route.query.redirect)
    const data = await api.loginUrl()
    window.location.href = data.authorize_url
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法发起登录'
    loading.value = false
  }
}

const TerraMark = {
  template: `
    <svg viewBox="0 0 58 58" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="terra-mark-vue" x1="8" y1="8" x2="50" y2="51" gradientUnits="userSpaceOnUse">
          <stop stop-color="#9DEBFF" />
          <stop offset=".48" stop-color="#5C8BFF" />
          <stop offset="1" stop-color="#B56DFF" />
        </linearGradient>
      </defs>
      <circle cx="29" cy="29" r="22" stroke="url(#terra-mark-vue)" stroke-width="1.4" stroke-dasharray="2 4" opacity=".7" />
      <path d="M16 25.2 29 16l13 9.2v14.1L29 47l-13-7.7V25.2Z" stroke="url(#terra-mark-vue)" stroke-width="2" />
      <path d="m16.5 25.5 12.7 7.8 12.4-7.8M29.2 33.3V47" stroke="url(#terra-mark-vue)" stroke-width="1.7" />
      <circle cx="29" cy="15.8" r="3" fill="#B9F4FF" />
      <circle cx="16" cy="25.4" r="2.2" fill="#789BFF" />
      <circle cx="42" cy="25.4" r="2.2" fill="#C183FF" />
    </svg>
  `,
}

const NetworkArt = {
  template: `
    <svg viewBox="0 0 640 500" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="login-line-vue" x1="80" y1="80" x2="560" y2="410" gradientUnits="userSpaceOnUse">
          <stop stop-color="#70E5FF" stop-opacity=".55" />
          <stop offset="1" stop-color="#9577FF" stop-opacity=".08" />
        </linearGradient>
        <radialGradient id="login-orb-vue">
          <stop stop-color="#5CD8FF" stop-opacity=".45" />
          <stop offset="1" stop-color="#5CD8FF" stop-opacity="0" />
        </radialGradient>
        <filter id="login-glow-vue"><feGaussianBlur stdDeviation="12" /></filter>
      </defs>
      <circle cx="470" cy="92" r="150" fill="url(#login-orb-vue)" filter="url(#login-glow-vue)" opacity=".28" />
      <ellipse cx="330" cy="268" rx="213" ry="94" stroke="url(#login-line-vue)" stroke-width="1" transform="rotate(-20 330 268)" />
      <ellipse cx="330" cy="268" rx="213" ry="94" stroke="url(#login-line-vue)" stroke-width="1" opacity=".5" transform="rotate(48 330 268)" />
      <path d="M86 389 198 283l86 41 118-154 120 72" stroke="url(#login-line-vue)" stroke-width="1" stroke-dasharray="4 8" />
      <path d="M144 116 262 190l128-60 112 88" stroke="url(#login-line-vue)" stroke-width="1" stroke-dasharray="3 9" opacity=".6" />
      <g v-for="node in [[86,389,0],[198,283,1],[284,324,2],[402,170,0],[522,242,1],[144,116,2],[262,190,0],[390,130,1]]" :key="node.join('-')">
        <circle :cx="node[0]" :cy="node[1]" r="4" :fill="node[2] === 0 ? '#A2F1FF' : '#9A87FF'" />
        <circle :cx="node[0]" :cy="node[1]" r="11" :stroke="node[2] === 0 ? '#64DFFF' : '#9077FF'" opacity=".25" />
      </g>
    </svg>
  `,
}

const SparklesIcon = { template: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l1.6 5.1L19 10l-5.4 1.9L12 17l-1.6-5.1L5 10l5.4-1.9L12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M19 15l.8 2.4L22 18l-2.2.6L19 21l-.8-2.4L16 18l2.2-.6L19 15Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>' }
const LockIcon = { template: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 10V8a5 5 0 0 1 10 0v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="5" y="10" width="14" height="10" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M12 14v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' }
const ArrowIcon = { template: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 17 17 7M9 7h8v8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' }
const ShieldIcon = { template: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3 19 6v5c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V6l7-3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>' }
const KeyIcon = { template: '<svg viewBox="0 0 24 24" fill="none"><path d="M9.5 14.5a4 4 0 1 1 2.8 1.2L10 18H8v2H5v-3l3.3-3.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' }
</script>

<style scoped>
.login {
  min-height: 100vh;
  position: relative;
  overflow: hidden;
  color: #f5f7ff;
  background: #070b18;
}
.bg,
.grid {
  position: absolute;
  inset: 0;
}
.bg {
  background:
    radial-gradient(780px 500px at 12% 8%, rgba(71, 103, 210, 0.24), transparent 64%),
    radial-gradient(680px 460px at 88% 92%, rgba(126, 78, 198, 0.22), transparent 62%),
    linear-gradient(135deg, #070b18 0%, #0a1021 48%, #0b0e1b 100%);
}
.grid {
  opacity: 0.18;
  background-image:
    linear-gradient(rgba(150, 180, 255, 0.12) 1px, transparent 1px),
    linear-gradient(90deg, rgba(150, 180, 255, 0.12) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: linear-gradient(to bottom, #000, transparent 75%);
}
.shell {
  min-height: 100vh;
  width: min(1240px, 100%);
  margin: 0 auto;
  padding: 32px clamp(20px, 5vw, 56px);
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 430px;
  align-items: center;
  gap: clamp(48px, 8vw, 92px);
}
.story {
  min-height: 620px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.brand,
.mobile-brand,
.status,
.eyebrow,
.assurance p {
  display: flex;
  align-items: center;
}
.brand {
  gap: 13px;
  color: #fff;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.18em;
}
.brand b {
  border: 1px solid rgba(165, 226, 255, 0.2);
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 9px;
  font-weight: 600;
  color: rgba(207, 244, 255, 0.62);
  letter-spacing: 0.2em;
}
.brand-mark,
.mobile-mark {
  width: 40px;
  height: 40px;
  flex: none;
}
.hero {
  position: relative;
  max-width: 590px;
}
.network {
  position: absolute;
  inset: -160px -120px -110px -90px;
  width: calc(100% + 220px);
  height: calc(100% + 270px);
  pointer-events: none;
  opacity: 0.88;
}
.eyebrow {
  position: relative;
  z-index: 1;
  gap: 8px;
  margin: 0 0 22px;
  color: rgba(165, 243, 252, 0.72);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.26em;
  text-transform: uppercase;
}
.eyebrow svg {
  width: 15px;
  height: 15px;
}
h1 {
  position: relative;
  z-index: 1;
  max-width: 600px;
  margin: 0;
  font-size: clamp(54px, 6vw, 76px);
  line-height: 1.04;
  letter-spacing: -0.055em;
  font-weight: 760;
  color: #fff;
}
h1 span {
  display: block;
  background: linear-gradient(90deg, #b4f5ff 0%, #8fb5ff 47%, #c596ff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lead {
  position: relative;
  z-index: 1;
  max-width: 430px;
  margin: 28px 0 0;
  color: rgba(203, 213, 225, 0.72);
  font-size: 15px;
  line-height: 1.85;
}
.status {
  gap: 10px;
  color: rgba(148, 163, 184, 0.62);
  font-size: 12px;
}
.status i {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #6ee7b7;
  box-shadow: 0 0 14px #6ee7b7;
}
.status span {
  color: rgba(100, 116, 139, 0.7);
}
.panel {
  width: 100%;
  padding: 34px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 28px;
  background: rgba(16, 24, 45, 0.88);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(28px) saturate(155%);
  animation: rise 0.55s cubic-bezier(0.23, 1, 0.32, 1) both;
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
.mobile-brand {
  display: none;
  gap: 12px;
  margin-bottom: 30px;
  font-weight: 700;
  letter-spacing: 0.16em;
}
.lock {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(165, 243, 252, 0.2);
  border-radius: 17px;
  color: #a5f3fc;
  background: rgba(103, 232, 249, 0.08);
}
.lock svg {
  width: 22px;
  height: 22px;
}
h2 {
  margin: 22px 0 0;
  font-size: 29px;
  line-height: 1.15;
  letter-spacing: -0.04em;
  color: #fff;
}
.sub {
  margin: 10px 0 0;
  color: rgba(148, 163, 184, 0.86);
  font-size: 14px;
  line-height: 1.65;
}
.cta {
  width: 100%;
  height: 50px;
  margin-top: 28px;
  border: 0;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #071021;
  background: linear-gradient(90deg, #a5f3fc 0%, #93c5fd 100%);
  box-shadow: 0 12px 30px rgba(91, 195, 255, 0.17);
  font-size: 14px;
  font-weight: 760;
  cursor: pointer;
  transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), filter 200ms ease, opacity 200ms ease;
}
.cta:hover:not(:disabled) {
  filter: brightness(1.08);
}
.cta:active:not(:disabled) {
  transform: scale(0.975);
}
.cta:disabled {
  opacity: 0.58;
  cursor: wait;
}
.market-icon {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: #dffaff;
  background: rgba(7, 16, 33, 0.78);
  font-size: 11px;
  font-weight: 850;
}
.arrow {
  width: 17px;
  height: 17px;
  transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
.cta:hover:not(:disabled) .arrow {
  transform: translate(2px, -2px);
}
.error {
  margin: 16px 0 0;
  padding: 12px 14px;
  border: 1px solid rgba(253, 164, 175, 0.22);
  border-radius: 14px;
  color: #ffe4e6;
  background: rgba(251, 113, 133, 0.09);
  font-size: 13px;
  line-height: 1.55;
}
.divider {
  margin: 26px 0 18px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: rgba(100, 116, 139, 0.85);
  font-size: 11px;
}
.divider span {
  flex: 1;
  height: 1px;
  background: rgba(255, 255, 255, 0.09);
}
.assurance {
  display: grid;
  gap: 10px;
}
.assurance p {
  margin: 0;
  gap: 9px;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 13px;
  color: rgba(203, 213, 225, 0.78);
  background: rgba(255, 255, 255, 0.035);
  font-size: 13px;
}
.assurance svg {
  width: 16px;
  height: 16px;
  color: rgba(165, 243, 252, 0.78);
}
@media (max-width: 860px) {
  .shell {
    min-height: 100vh;
    grid-template-columns: 1fr;
    padding-top: 24px;
    padding-bottom: 24px;
  }
  .story {
    display: none;
  }
  .panel {
    max-width: 440px;
    margin: 0 auto;
    padding: 28px;
  }
  .mobile-brand {
    display: flex;
  }
}
@media (max-width: 420px) {
  .shell {
    padding-inline: 16px;
  }
  .panel {
    padding: 24px;
    border-radius: 24px;
  }
  h2 {
    font-size: 27px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .panel,
  .cta,
  .arrow {
    animation: none;
    transition: none;
  }
}
</style>
