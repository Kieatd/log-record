<script setup lang="ts">
import RealTimeNetwork from './components/real-time-network.vue';
import NetworkSearchFilter from './components/network-search-filter.vue';
</script>

<template>
  <div class="network-container">
    <NetworkSearchFilter />
    <RealTimeNetwork class="real-time" />
  </div>
</template>

<style scoped>
.network-container {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  /* 安全网：子元素万一溢出也只裁切，不让整页出现横向滚动。
     横向滚动会让整个界面错位，体验很差 */
  overflow: hidden;
}

.real-time {
  flex: 1;
  overflow: hidden;
}
</style>