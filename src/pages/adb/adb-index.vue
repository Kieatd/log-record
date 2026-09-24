<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { Modal, message } from 'ant-design-vue';
import { useI18n } from 'vue-i18n';
import ScrcpyView from './scrcpy-view.vue';
import {
  ApiOutlined,
  AppstoreAddOutlined,
  BugOutlined,
  BulbOutlined,
  CameraOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  DesktopOutlined,
  EditOutlined,
  FolderOpenOutlined,
  CloseCircleFilled,
  ExclamationCircleFilled,
  LinkOutlined,
  LoadingOutlined,
  MobileOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UploadOutlined,
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

const shooting = ref(false);

/** 截图记录：图片存在 userData/screenshots/，这里只拿缩略图 */
const shotsOpen = ref(false);
const shots = ref<{ name: string; size: number; mtime: number; thumb: string }[]>([]);
const shotsLoading = ref(false);
const shotCount = ref(0);
/** 磁盘上所有截图的文件名 */
const shotNames = ref<string[]>([]);
/**
 * 已经查看过的截图文件名。小红点显示的是「还没看过的张数」，
 * 看一张少一张，全看完红点就没了。
 */
const SEEN_SHOTS_KEY = 'Log Record$$seenShots';
const seenShots = ref<string[]>(
  (() => {
    try {
      const v = JSON.parse(localStorage.getItem(SEEN_SHOTS_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  })(),
);
/** 最近一张截图的缩略图，显示在磁贴右半边 */
const latestThumb = ref('');
const latestName = ref('');

const unseenCount = computed(
  () => shotNames.value.filter((n) => !seenShots.value.includes(n)).length,
);

function saveSeen() {
  try {
    localStorage.setItem(SEEN_SHOTS_KEY, JSON.stringify(seenShots.value));
  } catch {
    /* 存不下就算了 */
  }
}

function markShotSeen(name: string) {
  if (!name || seenShots.value.includes(name)) return;
  seenShots.value = [...seenShots.value, name];
  saveSeen();
}

function isShotNew(name: string) {
  return !seenShots.value.includes(name);
}
const viewerOpen = ref(false);
const viewerUrl = ref('');
const viewerName = ref('');

const wifiIp = ref('');
const busyWifi = ref(false);

const customCmd = ref('');
const busyCustom = ref(false);

interface InstallProgressState {
  phase: 'push' | 'install' | 'done';
  percent: number;
  bytes: number;
  total: number;
  text: string;
}
/** 安装进度：push 阶段有百分比，pm install 阶段只有文字 */
const installState = ref<InstallProgressState | null>(null);
const installElapsed = ref(0);
let installTimer: ReturnType<typeof setInterval> | null = null;

/** 包名 → 安装时间（毫秒）。ADB 不直接给，要解析 dumpsys package */
const installTimes = ref<Record<string, number>>({});
const timeLoading = ref(false);

/** 连上设备后自动开启屏幕常亮（默认开，可以关掉） */
const AUTO_STAY_ON_KEY = 'Log Record$$adbAutoStayOn';
const autoStayOn = ref(localStorage.getItem(AUTO_STAY_ON_KEY) !== '0');
watch(autoStayOn, (v) => {
  localStorage.setItem(AUTO_STAY_ON_KEY, v ? '1' : '0');
});
/** 本次运行里已经自动开过的设备，避免用户手动关掉后又给开回来 */
const autoStayOnDone = new Set<string>();

// 投屏面板常驻在右侧，不提供收起 —— 这就是想要的默认布局
const mirrorRunning = ref(false);
const mirrorStarting = ref(false);
const mirrorRef = ref<{ start: () => void; stop: () => Promise<void> } | null>(null);

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
  // 投屏投的是当前设备，换设备要先停掉（面板留着，方便在新设备上重开）
  if (mirrorRunning.value) await mirrorRef.value?.stop();
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
  await applyAutoStayOn();
}

/**
 * 连上设备后自动开启屏幕常亮。
 * 每个设备每次运行只做一次：用户手动关掉后，不会切个 tab 又被打开。
 */
async function applyAutoStayOn() {
  if (!autoStayOn.value || !ready.value) return;
  const serial = currentSerial.value;
  if (!serial || autoStayOnDone.has(serial)) return;
  autoStayOnDone.add(serial);
  if (stayAwake.value?.on) return;
  const res = await api.adbSetStayAwake(true, serial);
  if (res.state) stayAwake.value = res.state;
  if (res.ok) {
    pushLog(`${i18n.t('已自动开启屏幕常亮')}（${res.state?.modes?.join('、') || ''}）`, 'ok');
  }
}

async function toggleStayAwake(e?: MouseEvent) {
  if (!ready.value) return;
  // 开关自己点一下就够了，别让事件再冒泡到磁贴又切一次（那样会兜回原状态）
  const target = e?.target as HTMLElement | null;
  if (target?.closest('.tile-guard')) return;
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

function startInstallTimer() {
  installElapsed.value = 0;
  stopInstallTimer();
  installTimer = setInterval(() => {
    installElapsed.value += 1;
  }, 1000);
}

function stopInstallTimer() {
  if (installTimer !== null) {
    clearInterval(installTimer);
    installTimer = null;
  }
}

const elapsedText = computed(() => {
  const s = installElapsed.value;
  if (s < 60) return `${s} ${i18n.t('秒')}`;
  return `${Math.floor(s / 60)} ${i18n.t('分')} ${String(s % 60).padStart(2, '0')} ${i18n.t('秒')}`;
});

const mbText = computed(() => {
  const st = installState.value;
  if (!st || !st.total) return '';
  return `${(st.bytes / 1024 / 1024).toFixed(1)} / ${(st.total / 1024 / 1024).toFixed(1)} MB`;
});

async function cancelInstall() {
  if (!installTaskId.value) return;
  await api.adbCancelInstall(installTaskId.value);
  pushLog(i18n.t('已请求取消安装'), 'err');
}

const installTaskId = ref('');

async function installApk(apkPath: string) {
  if (!apkPath) {
    message.warning(i18n.t('没拿到文件路径，请用「点击选择」'));
    return;
  }
  const name = apkPath.split(/[\\/]/).pop() || apkPath;
  pushLog(`$ adb -s ${currentSerial.value} push ${name} → /data/local/tmp/`, 'info');
  installTaskId.value = `install-${Date.now()}`;
  installState.value = null;
  installing.value = true;
  startInstallTimer();
  try {
    const res = await api.adbInstall(
      apkPath,
      currentSerial.value,
      installTaskId.value,
      autoOpen.value,
    );
    pushLog(res.message, res.ok ? 'ok' : 'err');
    if (res.ok) message.success(res.message);
    else message.error(res.message);
  } finally {
    installing.value = false;
    installState.value = null;
    stopInstallTimer();
  }
}

/** 安装进度事件（主进程推过来的） */
function onInstallProgress(p: InstallProgressState) {
  // 结束后清掉，否则磁贴会一直停在上次的进度上
  if (p.phase === 'done') {
    installState.value = null;
    return;
  }
  installState.value = p;
}

/** 点磁贴安装，但要是点在勾选框上就别装 */
function onInstallTileClick(e: MouseEvent) {
  if (!ready.value || installing.value) return;
  // 勾选框 / 开关这类小控件不该吃掉磁贴的手势，反过来磁贴也别抢它们的点击
  const target = e.target as HTMLElement | null;
  if (target?.closest('.tile-guard')) return;
  pickAndInstall();
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

/* ---------------- 投屏 ---------------- */

/**
 * 磁贴上的开关控制投屏本身（面板常驻，不用管显隐）。
 */
async function toggleMirror() {
  if (!ready.value) {
    message.warning(i18n.t('先插上线，选中一台设备'));
    return;
  }
  if (mirrorRunning.value) {
    await mirrorRef.value?.stop();
    return;
  }
  mirrorRef.value?.start();
}

// 这里刻意不做「设备就绪就自动投屏」：面板默认在，但投屏必须用户自己点。
// 否则一插上手机就悄悄在手机上起一个服务，不合适。

/* ---------------- 卸载应用 ---------------- */

const uninstallOpen = ref(false);
const pkgList = ref<string[]>([]);
/** 包名 → 设备上 APK 的路径，读应用名要用 */
const pkgPaths = ref<Record<string, string>>({});
/**
 * 包名 → 应用名。安卓的应用名要从 APK 的 resources.arsc 里解析，
 * 每个应用要抽两个小文件，所以是后台分批加载 + 本地缓存。
 */
const LABELS_KEY = 'Log Record$$appLabels';
const appLabels = ref<Record<string, string>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(LABELS_KEY) || '{}');
    } catch {
      return {};
    }
  })(),
);
const labelProgress = ref({ done: 0, total: 0 });
const labelLoading = ref(false);
let labelTimer: ReturnType<typeof setTimeout> | null = null;
const pkgLoading = ref(false);
const pkgSearch = ref('');
const includeSystem = ref(false);
const keepData = ref(false);
const uninstallingPkg = ref('');

const filteredPkgs = computed(() => {
  const q = pkgSearch.value.trim().toLowerCase();
  const list = q
    ? pkgList.value.filter(
        (p) =>
          p.toLowerCase().includes(q) ||
          // 应用名和包名都能搜，中文应用名也能搜
          (appLabels.value[p] || '').toLowerCase().includes(q),
      )
    : pkgList.value.slice();
  // 按安装时间降序：最近装的排最前面，没读到的排最后
  return list.sort(
    (a, b) => (installTimes.value[b] || 0) - (installTimes.value[a] || 0),
  );
});

/** 行右侧显示的安装日期 */
function installDate(pkg: string) {
  const t = installTimes.value[pkg];
  if (!t) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadInstallTimes() {
  if (!ready.value) {
    installTimes.value = {};
    return;
  }
  timeLoading.value = true;
  try {
    const res = await api.adbInstallTimes(currentSerial.value);
    installTimes.value = res.times || {};
    if (!res.ok && res.message) pushLog(res.message, 'err');
  } finally {
    timeLoading.value = false;
  }
}

function saveLabels() {
  try {
    const keys = Object.keys(appLabels.value);
    // 别让缓存无限长
    if (keys.length > 800) {
      const trimmed: Record<string, string> = {};
      for (const k of keys.slice(-800)) trimmed[k] = appLabels.value[k];
      appLabels.value = trimmed;
    }
    localStorage.setItem(LABELS_KEY, JSON.stringify(appLabels.value));
  } catch {
    /* 存不下就算了 */
  }
}

/** 后台分批读当前可见列表里还没有应用名的那些 */
async function loadMissingLabels() {
  const missing = filteredPkgs.value
    .filter((p) => !appLabels.value[p] && pkgPaths.value[p])
    .slice(0, 120);
  if (!missing.length || labelLoading.value) return;

  labelLoading.value = true;
  labelProgress.value = { done: 0, total: missing.length };
  try {
    for (let i = 0; i < missing.length; i += 6) {
      const chunk = missing.slice(i, i + 6);
      const res = await api.adbAppLabels(
        chunk.map((p) => ({ packageName: p, apkPath: pkgPaths.value[p] })),
        currentSerial.value,
      );
      for (const item of res.labels || []) {
        if (item.label) appLabels.value[item.packageName] = item.label;
      }
      labelProgress.value = {
        done: Math.min(i + chunk.length, missing.length),
        total: missing.length,
      };
      saveLabels();
      // 让界面先画出已拿到的部分
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    labelLoading.value = false;
  }
}

async function loadPackages() {
  if (!ready.value) {
    pkgList.value = [];
    pkgPaths.value = {};
    return;
  }
  pkgLoading.value = true;
  try {
    const res = await api.adbPackages(currentSerial.value, includeSystem.value);
    pkgList.value = res.packages || [];
    pkgPaths.value = res.paths || {};
    if (!res.ok) pushLog(res.message, 'err');
    loadMissingLabels();
    loadInstallTimes();
  } finally {
    pkgLoading.value = false;
  }
}

// 搜索/切换系统应用后，把新露出来的那些应用名补上
watch([pkgSearch, includeSystem], () => {
  if (labelTimer) clearTimeout(labelTimer);
  labelTimer = setTimeout(loadMissingLabels, 350);
});

function openUninstall() {
  uninstallOpen.value = true;
  pkgSearch.value = '';
  loadPackages();
}

/** 卸载是破坏性的（默认连数据一起删），所以要二次确认 */
function confirmUninstall(pkg: string) {
  Modal.confirm({
    title: `${i18n.t('确定卸载')} ${pkg} ？`,
    content: keepData.value
      ? i18n.t('会保留应用的数据和缓存')
      : i18n.t('应用的数据和缓存会一起删除，不可恢复'),
    okText: i18n.t('卸载'),
    okType: 'danger',
    cancelText: i18n.t('取消'),
    onOk: () => doUninstall(pkg),
  });
}

async function doUninstall(pkg: string) {
  uninstallingPkg.value = pkg;
  pushLog(
    `$ adb -s ${currentSerial.value} shell pm uninstall --user 0 ${keepData.value ? '-k ' : ''}${pkg}`,
    'info',
  );
  try {
    const res = await api.adbUninstall(pkg, currentSerial.value, keepData.value);
    if (res.raw && !res.ok) pushLog(res.raw, 'err');
    pushLog(res.message, res.ok ? 'ok' : 'err');
    if (res.ok) {
      message.success(res.message);
      await loadPackages();
    } else {
      message.error(res.message);
    }
  } finally {
    uninstallingPkg.value = '';
  }
}

/* ---------------- 截图 ---------------- */

async function takeScreenshot() {
  shooting.value = true;
  pushLog(i18n.t('正在截图…'), 'info');
  try {
    const res = await api.adbScreencap(currentSerial.value);
    if (!res.ok) {
      pushLog(res.message, 'err');
      message.error(res.message);
      return;
    }
    // 必须重新读一遍列表：红点算的是「没看过的张数」，
    // 得先知道新文件的文件名，光加个计数是没用的
    await loadShotCount();
    await loadLatestShot();
    if (res.screenAwake === false) {
      // 还是那个坑：息屏截出来是全黑的，得说清楚
      pushLog(i18n.t('截图成功，但手机是息屏状态，截出来会是全黑的'), 'err');
      message.warning(i18n.t('截图成功，但手机息屏了，画面是全黑的'));
    } else {
      pushLog(`${i18n.t('截图成功')} → ${res.name || ''}`, 'ok');
      message.success(i18n.t('截图成功'));
    }
    if (shotsOpen.value) await loadShots();
  } finally {
    shooting.value = false;
  }
}

async function wakeUp() {
  const res = await api.adbWakeup(currentSerial.value);
  pushLog(res.message, res.ok ? 'ok' : 'err');
  message.info(res.message);
}

/** monkey 的应用下拉：有应用名就显示「应用名 (包名)」 */
const pkgOptions = computed(() =>
  pkgList.value.map((p) => ({
    value: p,
    label: appLabels.value[p] ? `${appLabels.value[p]} (${p})` : p,
  })),
);

/* ---------------- 一键填调试地址 ---------------- */

const fillBusy = ref(false);
const fillOpen = ref(false);
/** 本机局域网 IP，标题栏那个；填调试地址要用 */
const localIp = ref('');
const FILL_KEY = 'Log Record$$fillConfig';
const fillForm = reactive({
  /** 按钮上的文字，调试页里那个按钮 */
  buttonText: '设置',
  /** 填完要重启哪个 App */
  packageName: '',
  /** IP 没变时也重填 */
  force: false,
  ...(() => {
    try {
      return JSON.parse(localStorage.getItem(FILL_KEY) || '{}');
    } catch {
      return {};
    }
  })(),
});
watch(
  () => ({ ...fillForm }),
  (v) => localStorage.setItem(FILL_KEY, JSON.stringify(v)),
  { deep: true },
);

function openFillSettings() {
  fillOpen.value = true;
  if (!pkgList.value.length) loadPackages();
}

/**
 * 一键：把本机 IP 填进 App 调试页的输入框、点「设置」、再重启 App。
 *
 * 前提：手机上那个调试页已经打开、屏幕是亮的（这两个我们没法代劳）。
 * 走 uiautomator，不改 App 也不需要 root。
 */
async function fillDebugUrl() {
  if (!ready.value) {
    message.warning(i18n.t('先插上线，选中一台设备'));
    return;
  }
  fillBusy.value = true;
  try {
    const host = localIp.value || (await api.getIPAddress());
    localIp.value = host;
    pushLog(`${i18n.t('正在把')} ${host} ${i18n.t('填进 App 的调试地址')}…`, 'info');
    const res = await api.uiautoFillDebugUrl(
      host,
      currentSerial.value,
      fillForm.buttonText,
      `${window.screen.width}x${window.screen.height}`,
      fillForm.force,
    );
    for (const step of res.steps || []) pushLog(`  ${step}`, 'info');
    const cost = res.ms ? `（${(res.ms / 1000).toFixed(1)} 秒${res.cached ? '，走缓存' : ''}）` : '';
    pushLog(res.message + cost, res.ok ? 'ok' : 'err');
    if (!res.ok) {
      message.error(res.message);
      return;
    }
    message.success(res.message);

    if (fillForm.packageName) {
      pushLog(`${i18n.t('重启')} ${fillForm.packageName}…`, 'info');
      const r = await api.appRestart(fillForm.packageName, currentSerial.value);
      pushLog(r.message, r.ok ? 'ok' : 'err');
      if (r.ok) message.success(i18n.t('已重启，电脑上应该能收到了'));
      else message.warning(r.message);
    } else {
      message.info(i18n.t('地址填好了，记得重启 App 才生效'));
    }
  } finally {
    fillBusy.value = false;
  }
}

/* ---------------- monkey 压测 ---------------- */

const monkeyOpen = ref(false);
const monkeyRunning = ref(false);
const monkeyStarting = ref(false);
/** monkey 实际记录下来的动作数（不是事件数，详见 utils/monkey.ts 的注释） */
const monkeyActions = ref(0);
const monkeyElapsed = ref(0);
let monkeyTimer: ReturnType<typeof setInterval> | null = null;

const MONKEY_KEY = 'Log Record$$monkeyConfig';
const monkeyForm = reactive({
  packageName: '',
  count: 500,
  throttle: 300,
  seed: 0,
  ignoreCrashes: true,
  ignoreTimeouts: true,
  // 默认只在应用内操作：monkey 默认配比里 BACK/HOME/切应用占了很大一块，
  // 跑一会儿必然把人踢回桌面（实测 1500 事件会掉到桌面 6 次）
  stayInApp: true,
  ...(() => {
    try {
      return JSON.parse(localStorage.getItem(MONKEY_KEY) || '{}');
    } catch {
      return {};
    }
  })(),
});
watch(
  () => ({ ...monkeyForm }),
  (v) => localStorage.setItem(MONKEY_KEY, JSON.stringify(v)),
  { deep: true },
);

function monkeyElapsedText() {
  const s = monkeyElapsed.value;
  return s < 60 ? `${s} ${i18n.t('秒')}` : `${Math.floor(s / 60)} ${i18n.t('分')} ${String(s % 60).padStart(2, '0')} ${i18n.t('秒')}`;
}

async function openMonkeySettings() {
  monkeyOpen.value = true;
  // 选应用要用到已装应用列表，顺便把它读出来（带应用名）
  if (!pkgList.value.length) await loadPackages();
}

async function startMonkeyRun() {
  if (!ready.value) {
    message.warning(i18n.t('先插上线，选中一台设备'));
    return;
  }
  if (!monkeyForm.packageName) {
    message.warning(i18n.t('先选一个要测的应用'));
    monkeyOpen.value = true;
    return;
  }
  // 种子：留着能复现问题，所以随机生成后写回表单显示出来
  if (!monkeyForm.seed) {
    monkeyForm.seed = Math.floor(Math.random() * 1000000);
  }
  monkeyStarting.value = true;
  monkeyActions.value = 0;
  monkeyElapsed.value = 0;
  try {
    const res = await api.monkeyStart({
      serial: currentSerial.value,
      ...monkeyForm,
    });
    if (!res.ok) {
      message.error(res.message);
      return;
    }
    monkeyRunning.value = true;
    // 回显真实参数，别只写一半 —— 之前漏了 stayInApp 那三个归零参数，
    // 日志里看着和实际跑的对不上
    const flags = monkeyForm.stayInApp
      ? ' --pct-syskeys 0 --pct-majornav 0 --pct-appswitch 0'
      : '';
    pushLog(
      `$ adb -s ${currentSerial.value} shell monkey -p ${monkeyForm.packageName}` +
        ` --throttle ${monkeyForm.throttle} -s ${monkeyForm.seed}` +
        (monkeyForm.ignoreCrashes ? ' --ignore-crashes' : '') +
        (monkeyForm.ignoreTimeouts ? ' --ignore-timeouts' : '') +
        flags +
        ` -v ${monkeyForm.count}`,
      'info',
    );
    if (monkeyTimer) clearInterval(monkeyTimer);
    monkeyTimer = setInterval(() => (monkeyElapsed.value += 1), 1000);
  } finally {
    monkeyStarting.value = false;
  }
}

async function stopMonkeyRun() {
  await api.monkeyStop();
}

function toggleMonkey() {
  if (monkeyRunning.value) {
    stopMonkeyRun();
    return;
  }
  startMonkeyRun();
}

/* ---------------- 传文件到手机 ---------------- */

const pushing = ref(false);
const pushDragging = ref(false);
const pushState = ref<{
  percent: number;
  bytes: number;
  total: number;
  index: number;
  count: number;
  name: string;
} | null>(null);
const pushElapsed = ref(0);
const pushTaskId = ref('');
let pushTimer: ReturnType<typeof setInterval> | null = null;

const PUSH_DEST_KEY = 'Log Record$$pushDest';
const pushDest = ref(localStorage.getItem(PUSH_DEST_KEY) || '/sdcard/Download/');
const pushDestOpen = ref(false);

function savePushDest() {
  const v = pushDest.value.trim() || '/sdcard/Download/';
  pushDest.value = v.endsWith('/') ? v : `${v}/`;
  localStorage.setItem(PUSH_DEST_KEY, pushDest.value);
  pushDestOpen.value = false;
}

const pushMb = computed(() => {
  const st = pushState.value;
  if (!st || !st.total) return '';
  return `${(st.bytes / 1024 / 1024).toFixed(1)} / ${(st.total / 1024 / 1024).toFixed(1)} MB`;
});

async function doPush(paths: string[]) {
  if (!ready.value) {
    message.warning(i18n.t('先插上线，选中一台设备'));
    return;
  }
  if (!paths.length) return;
  pushTaskId.value = `push-${Date.now()}`;
  pushing.value = true;
  pushState.value = null;
  pushElapsed.value = 0;
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = setInterval(() => (pushElapsed.value += 1), 1000);
  pushLog(`${i18n.t('正在传到')} ${pushDest.value}（${paths.length} 项）…`, 'info');
  try {
    const res = await api.pushFiles(
      paths,
      pushDest.value,
      currentSerial.value,
      pushTaskId.value,
    );
    pushLog(res.message, res.ok ? 'ok' : 'err');
    if (res.ok) message.success(res.message);
    else if (!res.canceled) message.error(res.message);
  } finally {
    pushing.value = false;
    pushState.value = null;
    if (pushTimer) {
      clearInterval(pushTimer);
      pushTimer = null;
    }
  }
}

async function pickAndPush() {
  const res = await api.pushPick();
  if (!res.canceled) await doPush(res.paths);
}

async function cancelPush() {
  if (!pushTaskId.value) return;
  await api.pushCancel(pushTaskId.value);
  pushLog(i18n.t('已请求取消传输'), 'err');
}

function onPushDragOver(e: DragEvent) {
  e.preventDefault();
  pushDragging.value = true;
}

function onPushDragLeave() {
  pushDragging.value = false;
}

async function onPushDrop(e: DragEvent) {
  e.preventDefault();
  pushDragging.value = false;
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  const paths: string[] = [];
  for (const f of files) {
    try {
      const p = api.getPathForFile(f);
      if (p) paths.push(p);
    } catch {
      /* ignore */
    }
  }
  if (!paths.length) {
    message.warning(i18n.t('没拿到文件路径，请用「点击选择」'));
    return;
  }
  await doPush(paths);
}

/* ---------------- 截图记录 ---------------- */

async function loadShotCount() {
  try {
    const res = await api.shotsCount();
    shotCount.value = res?.count ?? 0;
    shotNames.value = res?.names ?? [];
    // 已经删掉的图片，从「已查看」里也清掉，免得数组越积越长
    const alive = new Set(shotNames.value);
    const pruned = seenShots.value.filter((n) => alive.has(n));
    if (pruned.length !== seenShots.value.length) {
      seenShots.value = pruned;
      saveSeen();
    }
  } catch {
    /* ignore */
  }
}

async function loadLatestShot() {
  try {
    const res = await api.shotsLatest();
    latestThumb.value = res?.thumb || '';
    latestName.value = res?.name || '';
  } catch {
    /* ignore */
  }
}

async function loadShots() {
  shotsLoading.value = true;
  try {
    const res = await api.shotsList();
    shots.value = res?.shots || [];
  } finally {
    shotsLoading.value = false;
  }
}

function openShots() {
  shotsOpen.value = true;
  loadShotCount();
  loadLatestShot();
  loadShots();
}

async function viewShot(name: string) {
  const res = await api.shotsRead(name);
  if (!res.ok) {
    message.error(res.message);
    await loadShots();
    return;
  }
  viewerUrl.value = res.dataUrl;
  viewerName.value = name;
  viewerOpen.value = true;
  // 看了就算已读，小红点对应减一
  markShotSeen(name);
}

async function saveShotAs(name: string) {
  const res = await api.shotsSaveAs(name);
  if (res.canceled) return;
  if (res.ok) {
    message.success(i18n.t('已保存'));
    pushLog(`${i18n.t('已保存到')} ${res.filePath}`, 'ok');
  } else {
    message.error(res.message || i18n.t('保存失败'));
  }
}

async function deleteShot(name: string) {
  const res = await api.shotsDelete(name);
  if (res.ok) {
    message.success(i18n.t('已删除'));
    await loadShots();
    await loadShotCount();
    await loadLatestShot();
  } else {
    message.error(res.message || '删除失败');
  }
}

function openShotsFolder() {
  api.shotsOpenFolder();
}

function shotTime(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shotSize(bytes: number) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
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
  if (api.onAdbProgress) {
    api.onAdbProgress((payload: InstallProgressState) => onInstallProgress(payload));
  }
  if (api.onMonkeyOutput) {
    api.onMonkeyOutput((line: string) => {
      // 崩溃/无响应单独标红，一眼能看见
      const bad = /CRASH|NOT RESPONDING|aborted/i.test(line);
      pushLog(line, bad ? 'err' : 'info');
    });
  }
  if (api.onMonkeyEvent) {
    api.onMonkeyEvent((n: number) => (monkeyActions.value = n));
  }
  if (api.onMonkeyClosed) {
    api.onMonkeyClosed(() => {
      monkeyRunning.value = false;
      if (monkeyTimer) {
        clearInterval(monkeyTimer);
        monkeyTimer = null;
      }
      monkeyStarting.value = false;
    });
  }
  if (api.onPushOutput) {
    api.onPushOutput((line: string) => pushLog(line, 'info'));
  }
  if (api.onPushProgress) {
    api.onPushProgress((p: any) => {
      if (p.taskId !== pushTaskId.value) return;
      pushState.value = p;
    });
  }
  // 截图记录和缩略图跟设备无关，先读 —— 原来排在设备那一串后面，
  // 而读设备 + 读常亮 + 自动开启常亮要好几秒，结果刚打开时缩略图是空的
  loadShotCount();
  loadLatestShot();
  await loadAdb();
  localIp.value = await api.getIPAddress();
  await loadDevices();
  await loadStayAwake();
});

onActivated(() => {
  // keep-alive 缓存了页面，切回来时刷新一下设备（可能刚插线/刚拔线）
  loadDevices().then(loadStayAwake);
  // 切回来也刷一下截图记录：可能刚截过图或者删过图
  loadShotCount();
  loadLatestShot();
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
    <div class="adb-main">
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
        @click="onInstallTileClick"
      >
        <div class="tile-icon">
          <LoadingOutlined v-if="installing" spin />
          <AppstoreAddOutlined v-else />
        </div>
        <div class="tile-title">{{ $t('安装应用') }}</div>

        <!-- 安装中：显示进度、用时、取消 -->
        <template v-if="installState">
          <a-progress
            v-if="installState.phase === 'push'"
            :percent="installState.percent"
            :show-info="false"
            size="small"
            class="tile-progress"
          />
          <div class="tile-desc">
            {{ installState?.text || $t('准备中…') }}
          </div>
          <div class="tile-desc tile-dim">
            {{ mbText }} · {{ $t('已用') }} {{ elapsedText }}
          </div>
          <a-button size="small" danger class="tile-cancel" @click.stop="cancelInstall">
            {{ $t('取消安装') }}
          </a-button>
        </template>

        <template v-else>
          <div class="tile-desc">
            {{ dragging ? $t('松手就开始安装') : $t('把 .apk 拖到这里，或点击选择') }}
          </div>
          <!-- 包一层 guard：antd 的 checkbox 根元素是 label，会往内部 input
               再派发一次 click，事件照样冒泡到磁贴，光在 checkbox 上写
               @click.stop 拦不住 -->
          <span class="tile-guard" @click.stop @mousedown.stop>
            <a-checkbox v-model:checked="autoOpen" class="tile-check" :disabled="!ready">
              {{ $t('安装后自动打开') }}
            </a-checkbox>
          </span>
        </template>
      </div>

      <!-- 卸载应用 -->
      <div
        class="tile"
        :class="{ 'tile-disabled': !ready }"
        @click="ready && openUninstall()"
      >
        <div class="tile-icon"><DeleteOutlined /></div>
        <div class="tile-title">{{ $t('卸载应用') }}</div>
        <div class="tile-desc">{{ $t('查看手机上装的应用并卸载') }}</div>
      </div>

      <!-- 截图：左边截屏，右边是最近一张缩略图（点开看全部） -->
      <div class="tile tile-split" :class="{ 'tile-disabled': !ready }">
        <div
          class="tile-half tile-half-act"
          :class="{ 'tile-half-disabled': shooting }"
          @click="ready && !shooting && takeScreenshot()"
        >
          <div class="tile-icon">
            <LoadingOutlined v-if="shooting" spin />
            <CameraOutlined v-else />
          </div>
          <div class="tile-title">{{ $t('截图') }}</div>
          <div class="tile-desc">
            {{ shooting ? $t('正在截图…') : $t('点这里截取手机画面') }}
          </div>
        </div>

        <div class="tile-half tile-half-shots" @click="ready && openShots()">
          <a-tooltip :title="$t('查看截图记录')">
            <a-badge
              :count="unseenCount"
              :overflow-count="99"
              size="small"
              :offset="[-4, 4]"
            >
              <img
                v-if="latestThumb"
                :src="latestThumb"
                class="tile-thumb"
                :title="latestName"
                alt=""
              />
              <div v-else class="tile-thumb tile-thumb-empty">
                <PictureOutlined />
              </div>
            </a-badge>
          </a-tooltip>
          <div class="tile-desc">{{ $t('截图记录') }}</div>
        </div>
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
          <span class="tile-guard" @click.stop @mousedown.stop>
            <a-switch
              size="small"
              :checked="!!stayAwake?.on"
              :disabled="!ready"
              :loading="busyStayOn"
              @click="toggleStayAwake"
            />
          </span>
        </div>
        <div class="tile-title">{{ $t('屏幕常亮') }}</div>
        <div class="tile-desc">{{ stayAwakeDesc }}</div>
        <span class="tile-guard" @click.stop @mousedown.stop>
          <a-checkbox v-model:checked="autoStayOn" class="tile-check">
            {{ $t('连接后自动开启') }}
          </a-checkbox>
        </span>
      </div>

      <!-- 投屏 -->
      <div
        class="tile"
        :class="{ 'tile-disabled': !ready, 'tile-on': mirrorRunning }"
        @click="toggleMirror"
      >
        <div class="tile-head">
          <div class="tile-icon">
            <DesktopOutlined />
          </div>
          <a-switch
            size="small"
            :checked="mirrorRunning"
            :disabled="!ready"
            :loading="mirrorStarting"
            @click.stop="toggleMirror"
          />
        </div>
        <div class="tile-title">{{ $t('投屏操控') }}</div>
        <div class="tile-desc">
          {{ mirrorRunning ? $t('已连接，右边就是手机画面') : $t('在电脑上看手机画面并直接操作') }}
        </div>
      </div>

      <!-- 无线连接 -->
      <div class="tile" :class="{ 'tile-disabled': !ready }">
        <div class="tile-icon"><WifiOutlined /></div>
        <a-tooltip :title="$t('插线时点一次「开启」，之后拔线也能用')">
          <div class="tile-title">{{ $t('无线调试') }}</div>
        </a-tooltip>
        <div class="tile-desc">{{ $t('插线开启一次，之后可拔线') }}</div>
        <div class="tile-stack">
          <a-input
            v-model:value="wifiIp"
            size="small"
            :placeholder="$t('手机 IP，例如 192.168.1.5')"
            :disabled="!ready"
            @click.stop
          />
          <div class="tile-row">
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
      </div>

      <!-- 自定义命令 -->
      <div class="tile" :class="{ 'tile-disabled': !ready }">
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

      <!-- 一键填调试地址：左边填+点设置，右边设置 -->
      <div class="tile tile-split" :class="{ 'tile-disabled': !ready }">
        <div
          class="tile-half tile-half-act"
          :class="{ 'tile-half-disabled': fillBusy }"
          @click="ready && !fillBusy && fillDebugUrl()"
        >
          <div class="tile-icon">
            <LoadingOutlined v-if="fillBusy" spin />
            <EditOutlined v-else />
          </div>
          <div class="tile-title">{{ $t('填调试地址') }}</div>
          <div class="tile-desc">
            {{ $t('打开 App 调试页后点这里') }}
          </div>
        </div>
        <div class="tile-half tile-half-shots" @click="openFillSettings">
          <SettingOutlined class="tile-open" />
          <div class="tile-desc">{{ $t('设置') }}</div>
        </div>
      </div>

      <!-- Monkey 压测：左边开始，右边设置参数 -->
      <div class="tile tile-split" :class="{ 'tile-disabled': !ready }">
        <div
          class="tile-half tile-half-act"
          :class="{ 'tile-half-disabled': monkeyStarting }"
          @click="ready && !monkeyStarting && toggleMonkey()"
        >
          <div class="tile-icon">
            <LoadingOutlined v-if="monkeyStarting" spin />
            <BugOutlined v-else />
          </div>
          <div class="tile-title">{{ $t('Monkey 压测') }}</div>
          <div class="tile-desc">
            <template v-if="monkeyRunning">
              {{ $t('运行中') }} · {{ $t('约') }} {{ monkeyActions }} {{ $t('个动作') }} ·
              {{ monkeyElapsedText() }}
            </template>
            <template v-else>{{ $t('点这里开始跑') }}</template>
          </div>
        </div>
        <div class="tile-half tile-half-shots" @click="openMonkeySettings">
          <SettingOutlined class="tile-open" />
          <div class="tile-desc">{{ $t('设置参数') }}</div>
        </div>
      </div>

      <!-- 传文件到手机 -->
      <div
        class="tile"
        :class="{ 'tile-drop': pushDragging, 'tile-disabled': !ready || pushing }"
        @dragover="onPushDragOver"
        @dragleave="onPushDragLeave"
        @drop="onPushDrop"
        @click="ready && !pushing && pickAndPush()"
      >
        <div class="tile-head">
          <div class="tile-icon">
            <LoadingOutlined v-if="pushing" spin />
            <UploadOutlined v-else />
          </div>
          <span class="tile-guard" @click.stop @mousedown.stop>
            <a-tooltip :title="$t('改接收目录')">
              <FolderOpenOutlined class="tile-open" @click="pushDestOpen = true" />
            </a-tooltip>
          </span>
        </div>
        <div class="tile-title">{{ $t('传文件到手机') }}</div>
        <template v-if="pushing">
          <a-progress
            :percent="pushState?.percent ?? 0"
            :show-info="false"
            size="small"
            class="tile-progress"
          />
          <div class="tile-desc">
            {{ pushState ? `${pushState.index}/${pushState.count} ${pushState.name}` : $t('准备中…') }}
          </div>
          <div class="tile-desc tile-dim">
            {{ pushMb }} · {{ $t('已用') }} {{ pushElapsed }} {{ $t('秒') }}
          </div>
          <a-button size="small" danger class="tile-cancel" @click.stop="cancelPush">
            {{ $t('取消') }}
          </a-button>
        </template>
        <template v-else>
          <div class="tile-desc">
            {{ pushDragging ? $t('松手就开始传') : $t('把文件拖到这里，或点击选择') }}
          </div>
          <div class="tile-desc tile-dim">→ {{ pushDest }}</div>
        </template>
      </div>
    </div>

    <!-- ⑤ 输出 -->
    <div class="section-head">
      <span class="section-title">{{ $t('输出') }}</span>
      <a-tooltip :title="$t('清空输出')">
        <span class="section-action" @click="logs = []">{{ $t('清空') }}</span>
      </a-tooltip>
    </div>
    <!-- 卸载：应用列表 -->
    <a-modal
      v-model:open="uninstallOpen"
      :title="$t('卸载应用')"
      :footer="null"
      width="520px"
    >
      <div class="un-toolbar">
        <a-input
          v-model:value="pkgSearch"
          size="small"
          allow-clear
          :placeholder="$t('搜索包名')"
        >
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <a-tooltip :title="$t('系统应用卸了可能影响手机功能，谨慎操作')">
          <a-checkbox v-model:checked="includeSystem" @change="loadPackages">
            {{ $t('包含系统应用') }}
          </a-checkbox>
        </a-tooltip>
        <span v-if="timeLoading" class="un-hint">
          <LoadingOutlined spin />
          {{ $t('读取安装时间') }}
        </span>
        <span v-else-if="labelLoading" class="un-hint">
          <LoadingOutlined spin />
          {{ $t('读取应用名') }} {{ labelProgress.done }}/{{ labelProgress.total }}
        </span>
      </div>

      <div class="un-list">
        <div v-if="pkgLoading" class="un-empty">
          <LoadingOutlined spin />
          {{ $t('读取中…') }}
        </div>
        <div v-else-if="!filteredPkgs.length" class="un-empty">
          {{ $t('没有匹配的应用') }}
        </div>
        <div v-for="pkg in filteredPkgs" :key="pkg" class="un-item">
          <div class="un-info">
            <div class="un-name">{{ appLabels[pkg] || pkg }}</div>
            <div v-if="appLabels[pkg]" class="un-pkg">{{ pkg }}</div>
          </div>
          <span class="un-time">{{ installDate(pkg) }}</span>
          <a-button
            size="small"
            danger
            :loading="uninstallingPkg === pkg"
            @click="confirmUninstall(pkg)"
          >
            {{ $t('卸载') }}
          </a-button>
        </div>
      </div>

      <div class="un-foot">
        <a-checkbox v-model:checked="keepData">
          {{ $t('保留数据和应用缓存（-k）') }}
        </a-checkbox>
        <span class="un-count">
          {{ filteredPkgs.length }} / {{ pkgList.length }}
        </span>
      </div>
    </a-modal>

    <!-- 一键填地址的设置 -->
    <a-modal
      v-model:open="fillOpen"
      :title="$t('填调试地址设置')"
      :footer="null"
      width="460px"
    >
      <div class="mk-form">
        <div class="mk-row">
          <span class="mk-label">{{ $t('要填的地址') }}</span>
          <span class="mk-value">{{ localIp || $t('读取中…') }}</span>
        </div>
        <div class="mk-row">
          <span class="mk-label">{{ $t('按钮文字') }}</span>
          <a-input v-model:value="fillForm.buttonText" size="small" style="flex: 1" placeholder="设置" />
        </div>
        <div class="mk-row">
          <span class="mk-label">{{ $t('填完重启') }}</span>
          <a-select
            v-model:value="fillForm.packageName"
            show-search
            allow-clear
            size="small"
            style="flex: 1"
            :placeholder="pkgLoading ? $t('读取应用列表…') : $t('建议选上：填完自动重启这个 App')"
            :options="pkgOptions"
            :loading="pkgLoading"
          />
        </div>
        <div class="mk-row">
          <a-tooltip :title="$t('默认情况下，IP 没变就直接跳过填写（只重启 App），这样最快')">
            <a-checkbox v-model:checked="fillForm.force">
              {{ $t('IP 没变时也重填') }}
            </a-checkbox>
          </a-tooltip>
        </div>
        <div class="mk-tip">
          {{ $t('用法：先在手机上把 App 的调试页打开（就是填调试Url那个页面），再点磁贴左半边。它会自动找到输入框、清空、填上本机 IP、点按钮，最后重启 App') }}
        </div>
        <div class="mk-tip">
          {{ $t('填完会回读一次输入框内容做校验，不对就不会去点按钮') }}
        </div>
      </div>
      <div class="mk-foot">
        <a-button size="small" @click="fillOpen = false">{{ $t('关闭') }}</a-button>
      </div>
    </a-modal>

    <!-- monkey 设置 -->
    <a-modal
      v-model:open="monkeyOpen"
      :title="$t('Monkey 设置')"
      :footer="null"
      width="460px"
    >
      <div class="mk-form">
        <div class="mk-row">
          <span class="mk-label">{{ $t('测试哪个应用') }}</span>
          <a-select
            v-model:value="monkeyForm.packageName"
            show-search
            size="small"
            style="flex: 1"
            :placeholder="pkgLoading ? $t('读取应用列表…') : $t('选一个应用（只列第三方）')"
            :options="pkgOptions"
            :loading="pkgLoading"
          />
        </div>
        <div class="mk-row">
          <span class="mk-label">{{ $t('事件数量') }}</span>
          <a-input-number v-model:value="monkeyForm.count" :min="1" :max="1000000" size="small" style="flex: 1" />
        </div>
        <div class="mk-row">
          <span class="mk-label">{{ $t('间隔（毫秒）') }}</span>
          <a-input-number v-model:value="monkeyForm.throttle" :min="0" :max="10000" size="small" style="flex: 1" />
        </div>
        <div class="mk-row">
          <span class="mk-label">{{ $t('随机种子') }}</span>
          <a-input-number v-model:value="monkeyForm.seed" :min="0" size="small" style="flex: 1" />
          <span class="mk-hint">{{ $t('留着能复现问题') }}</span>
        </div>
        <div class="mk-row">
          <a-checkbox v-model:checked="monkeyForm.ignoreCrashes">{{ $t('忽略崩溃继续跑') }}</a-checkbox>
          <a-checkbox v-model:checked="monkeyForm.ignoreTimeouts">{{ $t('忽略无响应继续跑') }}</a-checkbox>
        </div>
        <div class="mk-row">
          <a-tooltip
            :title="$t('monkey 默认有相当比例的事件是 BACK/HOME/切换应用，跑一会儿就会回到桌面；勾上就只发点按滑动这类应用内操作')"
          >
            <a-checkbox v-model:checked="monkeyForm.stayInApp">
              {{ $t('只在应用内操作（不发 BACK/HOME）') }}
            </a-checkbox>
          </a-tooltip>
        </div>
        <div class="mk-tip">
          {{ $t('monkey 会往应用里随机点按滑动，用来跑稳定性；输出里出现 CRASH 会被标红') }}
        </div>
        <div class="mk-tip">
          {{ $t('不勾「只在应用内操作」的话，它还会按 BACK/HOME 和切换应用，那是 monkey 的默认行为') }}
        </div>
      </div>
      <div class="mk-foot">
        <a-button size="small" @click="monkeyOpen = false">{{ $t('取消') }}</a-button>
        <a-button
          size="small"
          type="primary"
          @click="
            monkeyOpen = false;
            startMonkeyRun();
          "
        >
          <PlayCircleOutlined />
          {{ $t('开始') }}
        </a-button>
      </div>
    </a-modal>

    <!-- 传文件的接收目录 -->
    <a-modal
      v-model:open="pushDestOpen"
      :title="$t('手机上的接收目录')"
      :footer="null"
      width="420px"
    >
      <a-input v-model:value="pushDest" size="small" placeholder="/sdcard/Download/" />
      <div class="mk-tip">
        {{ $t('默认放到 Download 目录，手机上打开「文件管理」就能看到') }}
      </div>
      <div class="mk-foot">
        <a-button size="small" @click="pushDestOpen = false">{{ $t('取消') }}</a-button>
        <a-button size="small" type="primary" @click="savePushDest">{{ $t('保存') }}</a-button>
      </div>
    </a-modal>

    <!-- 截图记录 -->
    <a-modal
      v-model:open="shotsOpen"
      :title="$t('截图记录')"
      :footer="null"
      width="680px"
    >
      <div class="shots-bar">
        <span class="shots-count">
          {{ shotCount }} {{ $t('张') }}
          <template v-if="unseenCount">
            · <span class="shots-unseen">{{ unseenCount }} {{ $t('张没看过') }}</span>
          </template>
        </span>
        <a-space :size="6">
          <a-button size="small" @click="wakeUp">
            <ThunderboltOutlined />
            {{ $t('唤醒屏幕') }}
          </a-button>
          <a-button size="small" @click="openShotsFolder">
            {{ $t('打开文件夹') }}
          </a-button>
        </a-space>
      </div>

      <div v-if="shotsLoading" class="shots-empty">
        <LoadingOutlined spin />
        {{ $t('读取中…') }}
      </div>
      <div v-else-if="!shots.length" class="shots-empty">
        {{ $t('还没有截图') }}
      </div>
      <div v-else class="shots-grid">
        <div
          v-for="s in shots"
          :key="s.name"
          class="shot-card"
          :class="{ 'shot-card-new': isShotNew(s.name) }"
        >
          <img
            v-if="s.thumb"
            :src="s.thumb"
            class="shot-thumb"
            @click="viewShot(s.name)"
          />
          <div v-else class="shot-thumb shot-thumb-bad">{{ $t('读不出来') }}</div>
          <span v-if="isShotNew(s.name)" class="shot-new-dot">{{ $t('新') }}</span>
          <div class="shot-meta">
            <span class="shot-name" :title="s.name">{{ s.name }}</span>
            <span class="shot-sub">{{ shotTime(s.mtime) }} · {{ shotSize(s.size) }}</span>
          </div>
          <div class="shot-actions">
            <a-button size="small" @click="saveShotAs(s.name)">{{ $t('另存为') }}</a-button>
            <a-popconfirm
              :title="$t('删掉这张截图？')"
              :ok-text="$t('删除')"
              :cancel-text="$t('取消')"
              @confirm="deleteShot(s.name)"
            >
              <a-button size="small" danger>{{ $t('删除') }}</a-button>
            </a-popconfirm>
          </div>
        </div>
      </div>
    </a-modal>

    <!-- 看大图 -->
    <a-modal
      v-model:open="viewerOpen"
      :title="viewerName"
      :footer="null"
      width="fit-content"
      centered
    >
      <img :src="viewerUrl" class="shot-full" />
      <div class="shot-full-actions">
        <a-button size="small" type="primary" @click="saveShotAs(viewerName)">
          {{ $t('另存为') }}
        </a-button>
      </div>
    </a-modal>

    <div ref="logBox" class="adb-log">
      <div v-if="!logs.length" class="log-empty">{{ $t('这里会显示每条命令的输出') }}</div>
      <div v-for="(l, i) in logs" :key="i" class="log-line" :class="'log-' + l.type">
        {{ l.text }}
      </div>
    </div>
    </div>

    <!-- 右边：投屏面板，常驻 -->
    <div class="adb-side">
      <ScrcpyView
        ref="mirrorRef"
        :serial="currentSerial"
        @log="(t: string) => pushLog(t)"
        @running="(v: boolean) => (mirrorRunning = v)"
        @starting="(v: boolean) => (mirrorStarting = v)"
      />
    </div>
  </div>
</template>

<style scoped>
.adb-page {
  display: flex;
  flex-direction: row;
  gap: 10px;
  padding: 10px 14px 20px;
  height: 100%;
  /* 父级 .body 是 flex 行容器，不写这行的话页面会按内容宽度收缩，
     右边留一大块空白。width: 0 + flex: 1 是项目里日志页的做法 */
  flex: 1;
  width: 0;
  overflow: hidden;
}

/* 左边：原来那些内容，自己滚 */
.adb-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
}

/* 右边：投屏面板。手机是竖屏，340px 宽差不多正好 */
.adb-side {
  width: 340px;
  flex-shrink: 0;
  height: 100%;
  min-height: 0;
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
  /* 列宽给大一点（280 起步），宽窗口下正好 4 列：
     第一行 安装/卸载/截图/屏幕常亮，第二行 无线调试(占2)+自定义命令(占2)，
     两行都排满，右下角不会空一块 */
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  /* 统一行高：无线调试那格有输入框+按钮，实测内容需要 167px。
     把最小行高定成 167，所有行就都一样高了（内容更多的行会自动长高） */
  grid-auto-rows: minmax(167px, auto);
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
/* 开着的时候给个淡色底，和关掉区分开 */
.tile-on {
  border-color: #33666680;
  background-color: #3366660d;
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
/* 输入框 + 按钮在窄磁贴里放不下，改成上下堆叠 */
.tile-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
/* 勾选框别跟着磁贴的鼠标手势走，只吃自己的点击 */
.tile-check {
  font-size: 11px;
  color: #666;
}
.tile-guard {
  display: inline-block;
  margin-top: 4px;
}
.tile-progress {
  margin: 2px 0 0;
}
.tile-progress :deep(.ant-progress-outer) {
  padding-right: 0;
}
.tile-dim {
  color: #bbb;
}
.tile-cancel {
  margin-top: 4px;
  align-self: flex-start;
}

/* ---- 截图磁贴：左右两半 ---- */
.tile-split {
  flex-direction: row;
  align-items: stretch;
  gap: 0;
  padding: 0;
  cursor: default;
  overflow: hidden;
}
.tile-split:hover {
  border-color: #d9d9d9;
  box-shadow: none;
}
.tile-half {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  min-width: 0;
  transition: background-color 0.2s;
}
/* 左半：截图 */
.tile-half-act {
  flex: 1;
  justify-content: center;
  cursor: pointer;
  border-right: 1px solid #f0f0f0;
}
.tile-half-act:hover {
  background-color: #3366660d;
}
.tile-half-disabled {
  cursor: wait;
}
/* 右半：最近一张缩略图，点开看全部 */
.tile-half-shots {
  width: 104px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.tile-half-shots:hover {
  background-color: #3366660d;
}
.tile-thumb {
  display: block;
  max-height: 74px;
  max-width: 68px;
  border-radius: 3px;
  box-shadow: 0 1px 4px #00000026;
}
.tile-thumb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 74px;
  color: #ccc;
  font-size: 18px;
  background-color: #fafafa;
  box-shadow: none;
  border: 1px dashed #e0e0e0;
}
.shots-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.shots-count {
  font-size: 12px;
  color: #999;
}
.shots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  max-height: 460px;
  overflow-y: auto;
}
.shot-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
}
/* 没看过的加个边框和角标，一眼能看出哪几张是新的 */
.shot-card-new {
  border-color: #ff4d4f66;
  box-shadow: 0 0 0 1px #ff4d4f22;
}
.shot-new-dot {
  position: absolute;
  top: -6px;
  left: -6px;
  z-index: 2;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background-color: #ff4d4f;
  color: #fff;
  font-size: 10px;
  line-height: 18px;
  text-align: center;
}
.shots-unseen {
  color: #ff4d4f;
}
.shot-thumb {
  width: 100%;
  height: 160px;
  object-fit: cover;
  object-position: top;
  border-radius: 4px;
  background-color: #f5f5f5;
  cursor: zoom-in;
}
.shot-thumb-bad {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #bbb;
  font-size: 11px;
  cursor: default;
}
.shot-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.shot-name {
  font-size: 11px;
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shot-sub {
  font-size: 10px;
  color: #bbb;
}
.shot-actions {
  display: flex;
  gap: 4px;
}
.shots-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 30px;
  color: #999;
  font-size: 12px;
}
.shot-full {
  max-width: 74vw;
  max-height: 74vh;
  display: block;
  margin: 0 auto;
}
.shot-full-actions {
  display: flex;
  justify-content: center;
  margin-top: 10px;
}

/* ---- 截图（旧的预览块已移除） ---- */
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

/* ---- monkey 设置弹层 ---- */
.mk-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mk-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mk-label {
  width: 84px;
  flex-shrink: 0;
  font-size: 12px;
  color: #666;
}
.mk-hint {
  font-size: 11px;
  color: #bbb;
}
.mk-value {
  flex: 1;
  font-size: 12px;
  font-family: Menlo, Consolas, monospace;
  color: #336666;
}
.mk-tip {
  font-size: 11px;
  color: #999;
  line-height: 1.6;
  margin-top: 2px;
}
.mk-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

/* ---- 卸载弹层 ---- */
.un-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.un-list {
  max-height: 380px;
  overflow-y: auto;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
}
.un-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid #f5f5f5;
}
.un-item:last-child {
  border-bottom: 0;
}
.un-item:hover {
  background-color: #fafafa;
}
.un-time {
  flex-shrink: 0;
  font-size: 11px;
  color: #bbb;
  font-family: Menlo, Consolas, monospace;
}
.un-info {
  flex: 1;
  min-width: 0;
}
.un-name {
  font-size: 13px;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.un-pkg {
  font-size: 11px;
  font-family: Menlo, Consolas, monospace;
  color: #aaa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.un-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #999;
  white-space: nowrap;
}
.un-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  color: #999;
  font-size: 12px;
}
.un-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: #666;
}
.un-count {
  color: #bbb;
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
