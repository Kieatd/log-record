<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons-vue';
import { useI18n } from 'vue-i18n';

const platform = window.electronAPI.platform;
const i18n = useI18n();
// 本机局域网 IP：手机上要填的就是这个地址。
// 原来只能从「设置 → 连接说明」里看到，这里直接显示在标题旁边。
const ip = ref('');
// 复制成功后短暂换成对勾，给一个「确实复制了」的视觉反馈
const copied = ref(false);
let copiedTimer: NodeJS.Timeout | null = null;

onMounted(async () => {
  ip.value = await window.electronAPI.getIPAddress();
});

const copyIp = async () => {
  try {
    await navigator.clipboard.writeText(ip.value);
    message.info(i18n.t('复制成功'));
    copied.value = true;
    if (copiedTimer !== null) {
      clearTimeout(copiedTimer);
    }
    copiedTimer = setTimeout(() => {
      copied.value = false;
      copiedTimer = null;
    }, 1500);
  } catch (err) {
    message.warning(i18n.t('复制失败'));
    console.warn('无法复制 IP: ', err);
  }
};
</script>

<template>
  <div class="nav-bar-container">
    <img v-if="platform !== 'darwin'" src="../../assets/logo.svg" class="logo" alt="" />
    <div class="nav-title-box">
      <span class="title">{{ $t('日志系统') }}</span>
      <a-tooltip v-if="ip" :title="$t('本机 IP，手机上填这个地址（点击复制）')">
        <span class="ip-badge" @click="copyIp">
          <span class="ip-text">{{ ip }}</span>
          <CheckOutlined v-if="copied" class="ip-icon" />
          <CopyOutlined v-else class="ip-icon" />
        </span>
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped>
.nav-bar-container {
  display: flex;
  flex-direction: row;
  align-items: center;
  border-bottom: 2px solid #3366661a;
  height: 40px;
  -webkit-app-region: drag;
}

.logo {
  height: 25px;
  margin-left: 10px;
}

/* 类名故意加 nav- 前缀：log-search-filter.vue 里有个非 scoped 的
   `.title-box { background-color: #f5f5f5; padding: 10px }` 全局样式，
   一旦重名，导航栏标题就会被套上灰底和内边距（看起来像个长方形框）。 */
.nav-title-box {
  margin: 0 auto;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.title {
  font-size: 18px;
  font-weight: bold;
  color: #555;
}

/* 本机 IP：做成「可点击的控件」的观感——带复制图标 + 浅灰底 + 圆角，
   用户一眼能看出可以点。用中性灰而不是主题青色，避免抢走标题的注意力。
   注意：整个导航栏是窗口拖拽区（-webkit-app-region: drag），
   里面的可交互元素必须显式设为 no-drag，否则收不到点击。 */
.ip-badge {
  -webkit-app-region: no-drag;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background-color: rgba(0, 0, 0, 0.035);
  font-size: 12px;
  line-height: 16px;
  color: #777;
  user-select: none;
  transition:
    color 0.2s,
    background-color 0.2s,
    border-color 0.2s;
}

.ip-text {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}

.ip-icon {
  font-size: 11px;
  opacity: 0.65;
  transition: opacity 0.2s;
}

.ip-badge:hover {
  color: var(--color-main);
  background-color: rgba(51, 102, 102, 0.1);
  border-color: rgba(51, 102, 102, 0.35);
}

.ip-badge:hover .ip-icon {
  opacity: 1;
}

.ip-badge:active {
  background-color: rgba(51, 102, 102, 0.2);
}
</style>
