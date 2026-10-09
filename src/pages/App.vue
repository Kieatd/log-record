<script setup lang="ts">
import NavBar from './components/nav-bar.vue';
import MenuBar from './components/menu-bar.vue';
import useLogStore from '../stores/log';
import useAppStore from '@/stores/app';
import { onMounted } from 'vue';
import useNetworkStore from '@/stores/network';

const logStore = useLogStore();
const appStore = useAppStore();
const networkStore = useNetworkStore();


window.electronAPI.onGetLogMsg((msg) => {
  logStore.push(msg)
})

window.electronAPI.onGetNetworkMsg((msg) => {
  networkStore.updateTreeData(msg)
})

onMounted(() => {
  appStore.updateCheck()
})

/**
 * 独立投屏浮窗（#/float）：只渲染投屏面板，不要导航栏/菜单栏。
 * 这是单独的一个窗口，用同一个渲染入口、靠 hash 区分。
 */
const isFloatWindow = window.location.hash.startsWith('#/float');
</script>

<template>
  <div class="container">
    <!-- 投屏浮窗：整窗就是投屏面板 -->
    <router-view v-if="isFloatWindow" />
    <template v-else>
      <NavBar />
      <div class="body">
        <MenuBar />
        <router-view v-slot="{ Component }">
          <keep-alive>
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </div>
    </template>
  </div>
</template>

<style scoped>
.container {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 0px;
}

.body {
  display: flex;
  flex-direction: row;
  flex: 1;
  height: 0;
}

:deep(.ant-tag) {
  color: var(--color-text);
}

:deep(.ant-tag-success) {
  color: var(--vt-c-text-light-1);
}

:deep(.ant-tabs .ant-tabs-nav::before) {
  border-bottom: 1px solid var(--color-background-mute) !important;

}

:deep(.ant-tabs-nav .ant-tabs-tab-active) {
  background: var(--color-background);
  color: var(--color-main);
  border-bottom-color: var(--color-background) !important;
  border: 1px solid var(--color-background-mute);
}

:deep(.ant-tabs .ant-tabs-tab-remove) {
  color: var(--color-main);
}

:deep(.ant-tabs-tab.ant-tabs-tab-active .ant-tabs-tab-btn) {
  color: var(--color-main);
}

:deep(.ant-tree) {
  background: var(--color-background);
  color: var(--color-text);
}
</style>
