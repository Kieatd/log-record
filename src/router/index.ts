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
    }
  ]
})

export default router
