import { createRouter, createWebHistory } from 'vue-router'
import { isLoggedIn, auth, revalidateSso } from '../store/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
    },
    {
      path: '/',
      component: () => import('../components/AppShell.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', name: 'overview', component: () => import('../views/OverviewView.vue') },
        {
          path: 'playground',
          name: 'playground',
          component: () => import('../views/PlaygroundView.vue'),
        },
        { path: 'keys', name: 'keys', component: () => import('../views/KeysView.vue') },
        { path: 'usage', name: 'usage', component: () => import('../views/UsageView.vue') },
        { path: 'billing', name: 'billing', component: () => import('../views/BillingView.vue') },
        { path: 'models', name: 'models', component: () => import('../views/ModelsView.vue') },
        { path: 'docs', name: 'docs', component: () => import('../views/DocsView.vue') },
        {
          path: 'admin',
          name: 'admin',
          component: () => import('../views/AdminView.vue'),
          meta: { requiresAdmin: true },
        },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.requiresAuth) {
    // 每次页面加载向 unisso 复核一次共享 Cookie：其它平台单点登出后，这里刷新即失效；
    // unisso 不可达（503/网络）则保留本地会话，不误踢已登录用户。
    await revalidateSso()
    if (!isLoggedIn()) {
      return { name: 'login', query: { redirect: to.fullPath } }
    }
    if (to.meta.requiresAdmin && !auth.user?.isAdmin) {
      return { name: 'overview' }
    }
    return true
  }
  if (to.name === 'login') {
    if (isLoggedIn()) return { name: 'overview' }
    // 无本地会话：用共享 Cookie 静默登录，成功就不让用户看到表单
    const state = await revalidateSso()
    if (state === 'ok' && isLoggedIn()) {
      return typeof to.query.redirect === 'string' && to.query.redirect
        ? to.query.redirect
        : { name: 'overview' }
    }
  }
  return true
})

export default router
