<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue';
import { message } from 'ant-design-vue';
import { useI18n } from 'vue-i18n';
import {
  ApiOutlined,
  AppstoreAddOutlined,
  BulbOutlined,
  CameraOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  LinkOutlined,
  LoadingOutlined,
  MobileOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  UsbOutlined,
  WifiOutlined,
} from '@ant-design/icons-vue';

const i18n = useI18n();
const api = (window as any).electronAPI;

interface AdbInfo {
  found: boolean;
  file: string;
  version: string;
  source: AdbSource | 'none';
  sourceText: string;
  error?: string;
}
type AdbSource = 'custom' | 'bundled' | 'env' | 'sdk' | 'path' | 'none';

interface StayAwakeState {
  value: number;
  on: boolean;
  modes: string[];
  effective: boolean | null;
  awake: boolean | null;
}

interface AdbDevice {
  serial: string;
  state: string;
  model: string;
  brand?: string;
  androidVersion?: string;
  connection: 'usb' | 'wifi' | 'unknown';
}

const adb = ref<AdbInfo | null>(null);
const devices = ref<AdbDevice[]>([]);
const currentSerial = ref('');
const loadingDevices = ref(false);
const installing = ref(false);
const dragging = ref(false);

/** 输出面板：所有命令的输出都汇总到这里 */
const logs = ref<{ text: string; type: 'info' | 'ok' | 'err' }[]>([]);
const logBox = ref<HTMLElement | null>(null);

const shot = ref<{ dataUrl: string; awake: boolean | null } | null>(null);
const shooting = ref(false);

const wifiIp = ref('');
const busyWifi = ref(false);

const customCmd = ref('');
const busyCustom = ref(false);

const stayAwake = ref<StayAwakeState | null>(null);
const busyStayOn = ref(false);

// 安装后自动打开。这是个「用一次就想一直开着」的选项，所以记住它
const AUTO_OPEN_KEY = 'Log Record$$adbAutoOpen';
const autoOpen = ref(localStorage.getItem(AUTO_OPEN_KEY) === '1');
watch(autoOpen, (v) => {
  localStorage.setItem(AUTO_OPEN_KEY, v ? '1' : '0');
});

const currentDevice = computed(
  () => devices.value.find((d) => d.serial === currentSerial.value) || null,
);
/** 只有状态是 device 的才能执行命令 */
const ready = computed(() => currentDevice.value?.state === 'device');

function pushLog(text: string, type: 'info' | 'ok' | 'err' = 'info') {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    logs.value.push({ text: line, type });
  }
  if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500);
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
}

/* ---------------- adb 本身 ---------------- */

async function loadAdb() {
  adb.value = await api.adbInfo();
}

async function loadDevices() {
  loadingDevices.value = true;
  try {
    const res = await api.adbDevices();
    devices.value = res.devices || [];
    if (!res.ok) {
      pushLog(res.message, 'err');
    } else if (!devices.value.length) {
      pushLog(i18n.t('没有检测到设备，检查数据线和手机上的「允许 USB 调试」'), 'err');
    }
    // 自动选中第一台可以用的
    if (!devices.value.some((d) => d.serial === currentSerial.value)) {
      currentSerial.value = devices.value.find((d) => d.state === 'device')?.serial
        || devices.value[0]?.serial
        || '';
    }
  } finally {
    loadingDevices.value = false;
  }
}

async function selectDevice(serial: string) {
  if (serial === currentSerial.value) return;
  currentSerial.value = serial;
  await loadStayAwake();
}

async function loadStayAwake() {
  if (!currentSerial.value) {
    stayAwake.value = null;
    return;
  }
  const res = await api.adbStayAwake(currentSerial.value);
  stayAwake.value = res.state;
}

async function toggleStayAwake() {
  if (!ready.value) return;
  busyStayOn.value = true;
  const next = !stayAwake.value?.on;
  try {
    const res = await api.adbSetStayAwake(next, currentSerial.value);
    if (res.state) stayAwake.value = res.state;
    pushLog(res.message, res.ok ? 'ok' : 'err');
    if (res.ok) message.success(res.message);
    else message.error(res.message);
  } finally {
    busyStayOn.value = false;
  }
}

async function pickAdb() {
  const res = await api.adbPick();
  if (res.canceled) return;
  adb.value = res.info;
  if (res.info?.found) {
    message.success(i18n.t('已使用你指定的 adb'));
    await loadDevices();
  } else {
    message.error(res.info?.error || i18n.t('这个文件不能用'));
  }
}

async function resetAdb() {
  adb.value = await api.adbSetPath('');
  await loadDevices();
}

/* ---------------- 安装 apk ---------------- */

async function installApk(apkPath: string) {
  if (!apkPath) {
    message.warning(i18n.t('没拿到文件路径，请用「点击选择」'));
    return;
  }
  const name = apkPath.split(/[\\/]/).pop() || apkPath;
  pushLog(`$ adb -s ${currentSerial.value} install -r -d -g ${name}`, 'info');
  installing.value = true;
  try {
    const res = await api.adbInstall(
      apkPath,
      currentSerial.value,
      'install',
      autoOpen.value,
    );
    pushLog(res.message, res.ok ? 'ok' : 'err');
    if (res.ok) message.success(res.message);
    else message.error(res.message);
  } finally {
    installing.value = false;
  }
}

async function pickAndInstall() {
  const res = await api.adbPickApk();
  if (!res.canceled) await installApk(res.apkPath);
}

/** 拖拽进入功能磁贴 */
function onDragOver(e: DragEvent) {
  e.preventDefault();
  dragging.value = true;
}
function onDragLeave() {
  dragging.value = false;
}
async function onDrop(e: DragEvent) {
  e.preventDefault();
  dragging.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  // Electron 32+ 删了 File.path，只能用 webUtils 拿真实路径
  let filePath = '';
  try {
    filePath = api.getPathForFile(file) || '';
  } catch (err) {
    console.warn('拿文件路径失败', err);
  }
  if (!/\.apk$/i.test(filePath || file.name)) {
    message.warning(i18n.t('只支持 .apk 安装包'));
    return;
  }
  await installApk(filePath);
}

/* ---------------- 截图 ---------------- */

async function takeScreenshot() {
  shooting.value = true;
  shot.value = null;
  pushLog(i18n.t('正在截图…'), 'info');
  try {
    const res = await api.adbScreencap(currentSerial.value);
    if (!res.ok) {
      pushLog(res.message, 'err');
      message.error(res.message);
      return;
    }
    shot.value = { dataUrl: res.dataUrl, awake: res.screenAwake };
    if (res.screenAwake === false) {
      pushLog(i18n.t('截图成功，但手机是息屏状态，截出来会是全黑的'), 'err');
    } else {
      pushLog(i18n.t('截图成功'), 'ok');
    }
  } finally {
    shooting.value = false;
  }
}

async function wakeUp() {
  const res = await api.adbWakeup(currentSerial.value);
  pushLog(res.message, res.ok ? 'ok' : 'err');
  message.info(res.message);
}

async function saveScreenshot() {
  if (!shot.value) return;
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .slice(0, 19);
  const res = await api.adbSaveImage(
    shot.value.dataUrl,
    `screenshot-${currentDevice.value?.model || 'device'}-${stamp}.png`,
  );
  if (!res.canceled) {
    pushLog(`${i18n.t('已保存到')} ${res.filePath}`, 'ok');
    message.success(i18n.t('已保存'));
  }
}

/* ---------------- 无线连接 ---------------- */

async function enableWifi() {
  if (!currentSerial.value) {
    message.warning(i18n.t('先插上线，选中一台设备'));
    return;
  }
  busyWifi.value = true;
  try {
    const res = await api.adbTcpip(currentSerial.value, 5555);
    pushLog(res.raw ? `$ adb tcpip 5555\n${res.raw}` : res.message, res.ok ? 'ok' : 'err');
    if (res.ok) {
      // 拔线前先记下手机 IP，方便下一步直接连
      const ipRes = await api.adbShell(
        'ip route | grep wlan | head -1',
        currentSerial.value,
      );
      const m = String(ipRes.message || '').match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m && !wifiIp.value) wifiIp.value = m[1];
      message.success(res.message);
    } else {
      message.error(res.message);
    }
  } finally {
    busyWifi.value = false;
  }
}

async function connectWifi() {
  if (!wifiIp.value.trim()) {
    message.warning(i18n.t('填一下手机的 IP'));
    return;
  }
  busyWifi.value = true;
  try {
    const res = await api.adbConnect(wifiIp.value.trim(), 5555);
    pushLog(`$ adb connect ${wifiIp.value.trim()}:5555\n${res.raw || res.message}`, res.ok ? 'ok' : 'err');
    if (res.ok) {
      message.success(res.message);
      await loadDevices();
    } else {
      message.error(res.message);
    }
  } finally {
    busyWifi.value = false;
  }
}

/* ---------------- 自定义命令 ---------------- */

async function runCustom() {
  const cmd = customCmd.value.trim();
  if (!cmd) return;
  busyCustom.value = true;
  pushLog(`$ adb -s ${currentSerial.value} shell ${cmd}`, 'info');
  try {
    const res = await api.adbShell(cmd, currentSerial.value);
    pushLog(res.message, res.ok ? 'ok' : 'err');
  } finally {
    busyCustom.value = false;
  }
}

/* ---------------- 生命周期 ---------------- */

// 拖文件到窗口上时，Electron 默认会直接导航过去，把整页冲掉，必须全局拦掉
function blockWindowDrop(e: DragEvent) {
  e.preventDefault();
}

let offOutput: (() => void) | null = null;

onMounted(async () => {
  window.addEventListener('dragover', blockWindowDrop);
  window.addEventListener('drop', blockWindowDrop);
  if (api.onAdbOutput) {
    api.onAdbOutput((payload: { text: string }) => pushLog(payload.text));
  }
  await loadAdb();
  await loadDevices();
  await loadStayAwake();
});

onActivated(() => {
  // keep-alive 缓存了页面，切回来时刷新一下设备（可能刚插线/刚拔线）
  loadDevices().then(loadStayAwake);
});

onUnmounted(() => {
  window.removeEventListener('dragover', blockWindowDrop);
  window.removeEventListener('drop', blockWindowDrop);
  offOutput?.();
});

/* ---------------- 展示用 ---------------- */

function stateIcon(state: string) {
  if (state === 'device') return CheckCircleFilled;
  if (state === 'unauthorized') return ExclamationCircleFilled;
  return CloseCircleFilled;
}
function stateText(state: string) {
  if (state === 'device') return i18n.t('可用');
  if (state === 'unauthorized') return i18n.t('未授权，手机上点「允许 USB 调试」');
  if (state === 'offline') return i18n.t('离线');
  return state;
}
const stayAwakeDesc = computed(() => {
  const st = stayAwake.value;
  if (!st) return i18n.t('插着电时不让屏幕熄灭');
  if (!st.on) return i18n.t('插着电时不让屏幕熄灭');
  if (st.effective === false) return i18n.t('已开启，但当前没插电，暂时不生效');
  const modes = st.modes.join('、');
  return modes ? `${i18n.t('已开启')}（${modes}）` : i18n.t('已开启');
});

function deviceTitle(d: AdbDevice) {
  return d.model || d.serial;
}
function deviceSubtitle(d: AdbDevice) {
  const parts: string[] = [];
  if (d.brand) parts.push(d.brand);
  if (d.androidVersion) parts.push(`Android ${d.androidVersion}`);
  if (d.connection === 'usb') parts.push('USB');
  else if (d.connection === 'wifi') parts.push('WiFi');
  if (!d.model) parts.push(d.serial);
  return parts.join(' · ');
}
</script>

<template>
  <div class="adb-page">
    <!-- ① adb 状态：始终显示，找到就用它，找不到就引导手动指定 -->
    <div class="adb-bar" :class="{ 'adb-bar-bad': adb && !adb.found }">
      <template v-if="adb && adb.found">
        <ApiOutlined class="bar-icon" />
        <span class="bar-text">
          <span class="bar-strong">adb {{ adb.version || '未知版本' }}</span>
          <a-tooltip :title="adb.file">
            <span class="bar-path">{{ adb.file }}</span>
          </a-tooltip>
          <span class="bar-source">（{{ adb.sourceText }}）</span>
        </span>
        <a-button size="small" type="text" @click="pickAdb">{{ $t('更换') }}</a-button>
      </template>
      <template v-else>
        <ExclamationCircleFilled class="bar-icon bar-icon-bad" />
        <span class="bar-text">{{ adb?.error || $t('没找到 adb') }}</span>
        <a-button size="small" type="primary" @click="pickAdb">
          {{ $t('选择 adb 文件') }}
        </a-button>
        <a-tooltip :title="$t('去下载 platform-tools')">
          <a-button
            size="small"
            type="text"
            @click="api.openUrl('https://developer.android.com/tools/releases/platform-tools')"
          >
            {{ $t('没装过？') }}
          </a-button>
        </a-tooltip>
      </template>
      <a-tooltip v-if="adb?.source === 'custom'" :title="$t('忘掉手动指定的，恢复自动探测')">
        <a-button size="small" type="text" @click="resetAdb">{{ $t('恢复自动') }}</a-button>
      </a-tooltip>
    </div>

    <!-- ② 设备 -->
    <div class="section-head">
      <span class="section-title">{{ $t('设备') }}</span>
      <span v-if="devices.length" class="section-count">{{ devices.length }}</span>
      <a-tooltip :title="$t('重新扫描')">
        <ReloadOutlined class="section-action" :spin="loadingDevices" @click="loadDevices" />
      </a-tooltip>
    </div>

    <div v-if="devices.length" class="device-list">
      <div
        v-for="d in devices"
        :key="d.serial"
        class="device-card"
        :class="{ 'device-card-active': d.serial === currentSerial }"
        @click="selectDevice(d.serial)"
      >
        <MobileOutlined class="device-icon" />
        <div class="device-info">
          <div class="device-name">{{ deviceTitle(d) }}</div>
          <div class="device-sub">{{ deviceSubtitle(d) }}</div>
        </div>
        <div class="device-state" :class="'state-' + d.state">
          <component :is="stateIcon(d.state)" />
          <span>{{ stateText(d.state) }}</span>
        </div>
      </div>
    </div>
    <div v-else class="device-empty">
      <MobileOutlined />
      <span>{{ $t('没检测到设备。插上数据线，手机弹「允许 USB 调试」时点允许') }}</span>
    </div>

    <!-- ③ 功能磁贴 -->
    <div class="section-head">
      <span class="section-title">{{ $t('功能') }}</span>
    </div>

    <div class="tile-grid">
      <!-- 拖 APK 安装 -->
      <div
        class="tile"
        :class="{ 'tile-drop': dragging, 'tile-disabled': !ready || installing }"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
        @click="ready && pickAndInstall()"
      >
        <div class="tile-icon">
          <LoadingOutlined v-if="installing" spin />
          <AppstoreAddOutlined v-else />
        </div>
        <div class="tile-title">{{ $t('安装应用') }}</div>
        <div class="tile-desc">
          {{ dragging ? $t('松手就开始安装') : $t('把 .apk 拖到这里，或点击选择') }}
        </div>
        <a-checkbox
          v-model:checked="autoOpen"
          class="tile-check"
          :disabled="!ready"
          @click.stop
        >
          {{ $t('安装后自动打开') }}
        </a-checkbox>
      </div>

      <!-- 截图 -->
      <div
        class="tile"
        :class="{ 'tile-disabled': !ready || shooting }"
        @click="ready && !shooting && takeScreenshot()"
      >
        <div class="tile-icon">
          <LoadingOutlined v-if="shooting" spin />
          <CameraOutlined v-else />
        </div>
        <div class="tile-title">{{ $t('截图') }}</div>
        <div class="tile-desc">{{ $t('截取手机当前画面') }}</div>
      </div>

      <!-- 屏幕常亮 -->
      <div
        class="tile"
        :class="{ 'tile-disabled': !ready || busyStayOn }"
        @click="toggleStayAwake"
      >
        <div class="tile-head">
          <div class="tile-icon">
            <LoadingOutlined v-if="busyStayOn" spin />
            <BulbOutlined v-else />
          </div>
          <a-switch
            size="small"
            :checked="!!stayAwake?.on"
            :disabled="!ready"
            :loading="busyStayOn"
            @click.stop="toggleStayAwake"
          />
        </div>
        <div class="tile-title">{{ $t('屏幕常亮') }}</div>
        <div class="tile-desc">{{ stayAwakeDesc }}</div>
      </div>

      <!-- 无线连接 -->
      <div class="tile tile-wide" :class="{ 'tile-disabled': !ready }">
        <div class="tile-icon"><WifiOutlined /></div>
        <div class="tile-title">{{ $t('无线调试') }}</div>
        <div class="tile-desc">
          {{ $t('插线时点一次「开启」，之后拔线也能用') }}
        </div>
        <div class="tile-row">
          <a-input
            v-model:value="wifiIp"
            size="small"
            :placeholder="$t('手机 IP，例如 192.168.1.5')"
            :disabled="!ready"
            @click.stop
          />
          <a-button size="small" :disabled="!ready" :loading="busyWifi" @click.stop="enableWifi">
            <UsbOutlined />
            {{ $t('开启') }}
          </a-button>
          <a-button
            size="small"
            type="primary"
            :disabled="!ready && !wifiIp"
            :loading="busyWifi"
            @click.stop="connectWifi"
          >
            <LinkOutlined />
            {{ $t('连接') }}
          </a-button>
        </div>
      </div>

      <!-- 自定义命令 -->
      <div class="tile tile-wide" :class="{ 'tile-disabled': !ready }">
        <div class="tile-icon"><ThunderboltOutlined /></div>
        <div class="tile-title">{{ $t('自定义命令') }}</div>
        <div class="tile-desc">{{ $t('直接跑 adb shell 命令') }}</div>
        <div class="tile-row">
          <a-input
            v-model:value="customCmd"
            size="small"
            :placeholder="$t('例如 pm list packages -3')"
            :disabled="!ready"
            @press-enter="runCustom"
            @click.stop
          />
          <a-button
            size="small"
            type="primary"
            :disabled="!ready || !customCmd.trim()"
            :loading="busyCustom"
            @click.stop="runCustom"
          >
            <PlayCircleOutlined />
            {{ $t('执行') }}
          </a-button>
        </div>
      </div>
    </div>

    <!-- ④ 截图预览 -->
    <template v-if="shot">
      <div class="section-head">
        <span class="section-title">{{ $t('截图结果') }}</span>
        <a-space :size="6">
          <a-button size="small" @click="wakeUp">
            <ThunderboltOutlined />
            {{ $t('唤醒屏幕') }}
          </a-button>
          <a-button size="small" type="primary" @click="saveScreenshot">
            <SaveOutlined />
            {{ $t('保存') }}
          </a-button>
        </a-space>
      </div>
      <div class="shot-box">
        <img :src="shot.dataUrl" class="shot-img" alt="screenshot" />
      </div>
    </template>

    <!-- ⑤ 输出 -->
    <div class="section-head">
      <span class="section-title">{{ $t('输出') }}</span>
      <a-tooltip :title="$t('清空输出')">
        <span class="section-action" @click="logs = []">{{ $t('清空') }}</span>
      </a-tooltip>
    </div>
    <div ref="logBox" class="adb-log">
      <div v-if="!logs.length" class="log-empty">{{ $t('这里会显示每条命令的输出') }}</div>
      <div v-for="(l, i) in logs" :key="i" class="log-line" :class="'log-' + l.type">
        {{ l.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.adb-page {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 20px;
  overflow-y: auto;
  height: 100%;
}

/* ---- adb 状态行 ---- */
.adb-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background-color: #33666614;
  font-size: 12px;
}
.adb-bar-bad {
  background-color: #faad1420;
}
.bar-icon {
  color: #336666;
  flex-shrink: 0;
}
.bar-icon-bad {
  color: #faad14;
}
.bar-text {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: #666;
}
.bar-strong {
  color: #333;
  font-weight: 600;
  flex-shrink: 0;
}
.bar-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  max-width: 46%;
}
.bar-source {
  flex-shrink: 0;
  color: #999;
}

/* ---- 分组标题 ---- */
.section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}
.section-count {
  font-size: 11px;
  color: #999;
}
.section-action {
  font-size: 12px;
  color: #336666;
  cursor: pointer;
  user-select: none;
}
.section-action:hover {
  opacity: 0.7;
}

/* ---- 设备卡片 ---- */
.device-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.device-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  cursor: pointer;
  min-width: 240px;
  background-color: #fff;
  transition: all 0.2s;
}
.device-card:hover {
  border-color: #336666;
}
.device-card-active {
  border-color: #336666;
  background-color: #33666610;
}
.device-icon {
  font-size: 20px;
  color: #336666;
}
.device-info {
  flex: 1;
  min-width: 0;
}
.device-name {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}
.device-sub {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
}
.device-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  flex-shrink: 0;
}
.state-device {
  color: #52c41a;
}
.state-unauthorized {
  color: #faad14;
}
.state-offline {
  color: #999;
}
.device-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px;
  border: 1px dashed #d9d9d9;
  border-radius: 6px;
  color: #999;
  font-size: 12px;
}

/* ---- 功能磁贴 ---- */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background-color: #fff;
  cursor: pointer;
  transition: all 0.2s;
}
.tile:hover {
  border-color: #336666;
  box-shadow: 0 2px 6px #0000000f;
}
.tile-wide {
  grid-column: span 2;
  cursor: default;
}
.tile-drop {
  border-color: #336666;
  border-style: dashed;
  background-color: #33666615;
}
.tile-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tile-disabled:hover {
  border-color: #d9d9d9;
  box-shadow: none;
}
.tile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tile-icon {
  font-size: 18px;
  color: #336666;
}
.tile-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}
.tile-desc {
  font-size: 11px;
  color: #999;
}
.tile-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  align-items: center;
}
/* 勾选框别跟着磁贴的鼠标手势走，只吃自己的点击 */
.tile-check {
  margin-top: 4px;
  font-size: 11px;
  color: #666;
}

/* ---- 截图 ---- */
.shot-box {
  display: flex;
  justify-content: center;
  padding: 8px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background-color: #fafafa;
}
.shot-img {
  max-height: 380px;
  max-width: 100%;
  border-radius: 4px;
  box-shadow: 0 2px 8px #0000001f;
}

/* ---- 输出面板 ---- */
.adb-log {
  flex: 1;
  min-height: 120px;
  max-height: 240px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background-color: #1e1e1e;
  font-family: Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
}
.log-line {
  white-space: pre-wrap;
  word-break: break-all;
  color: #d4d4d4;
}
.log-ok {
  color: #4ec9b0;
}
.log-err {
  color: #f48771;
}
.log-empty {
  color: #666;
}
</style>
