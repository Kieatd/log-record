import { createRouter, createWebHashHistory } from 'vue-router'
import LoggersIndex from '../pages/loggers/loggers-index.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/log'
    },
    {
      path: '/log',
      name: 'log',
      component: LoggersIndex
    },
    {
      path: '/network',
      name: 'network',
      component: () => import('../pages/networks/networks-index.vue')
    },
    {
      path: '/adb',
      name: 'adb',
      component: () => import('../pages/adb/adb-index.vue')
    },
    {
      // 独立投屏浮窗（真窗口）：只渲染投屏面板，没有导航栏/菜单栏
      path: '/float',
      name: 'float',
      component: () => import('../pages/adb/mirror-window.vue')
    }
  ]
})

export default router
