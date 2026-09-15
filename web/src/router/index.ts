import { createRouter, createWebHistory } from 'vue-router'
import { isLoggedIn, isOAuthPending, auth } from '../store/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
    },
    {
      path: '/oauth/callback',
      name: 'oauth-callback',
      component: () => import('../views/OAuthCallbackView.vue'),
    },
    {
      path: '/',
      component: () => import('../components/AppShell.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', name: 'overview', component: () => import('../views/OverviewView.vue') },
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

router.beforeEach((to) => {
  if (to.query.code && to.query.state && to.name !== 'oauth-callback') {
    return { name: 'oauth-callback', query: { code: to.query.code, state: to.query.state } }
  }
  if (isOAuthPending()) return true
  if (to.meta.requiresAuth && !isLoggedIn()) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.meta.requiresAdmin && !auth.user?.isAdmin) {
    return { name: 'overview' }
  }
  if (to.name === 'login' && isLoggedIn()) {
    return { name: 'overview' }
  }
})

export default router
