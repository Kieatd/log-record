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
import {
  ApiOutlined,
  AppstoreAddOutlined,
  BugOutlined,
  BulbOutlined,
  CameraOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  DisconnectOutlined,
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
  FolderFilled,
  FileOutlined,
  DownloadOutlined,
  HomeOutlined,
  ArrowUpOutlined,
} from '@ant-design/icons-vue';
import ScrcpyView from './scrcpy-view.vue';

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
/**
 * USB 上「插着但没把 ADB 接口交出来」的手机（只在 macOS 上查得到）。
 * 一台可用设备都没有时才去查 —— 这正是「adb 看不见手机」的典型症状。
 */
const usbPhones = ref<{ node: string; name: string; hasAdb: boolean }[]>([]);
const restartingAdb = ref(false);
const installing = ref(false);
const dragging = ref(false);

/** 输出面板：所有命令的输出都汇总到这里 */
const logs = ref<{ text: string; type: 'info' | 'ok' | 'err' }[]>([]);
const logBox = ref<HTMLElement | null>(null);

const shooting = ref(false);

/** 截图记录：图片存在 userData/screenshots/，这里只拿缩略图 */
const shotsOpen = ref(false);
const shots = ref<
  { name: string; size: number; mtime: number; thumb: string }[]
>([]);
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

const wifiIp = ref(localStorage.getItem('Log Record$$wifiIp') || '');
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
/** 定期刷设备列表：拔线/插线、以及 tcpip 重启 adbd 导致 USB 记录短暂消失，都要能自己长回来 */
let devTimer: ReturnType<typeof setInterval> | null = null;

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
/** 自动切换无线时防止重入 */
let autoSwitching = false;

const mirrorRef = ref<{
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
} | null>(null);

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

/**
 * 同一台手机的 USB 和 WiFi 是 adb 里的两条记录（`device` 代号相同，比如都是 HWBND-H）。
 * 以前会显示成两张一模一样的卡片，容易看懵 —— 这里合并成一张，配一个 USB/WiFi 切换。
 */
const deviceGroups = computed(() => {
  type Group = {
    key: string;
    label: string;
    brand: string;
    androidVersion: string;
    usb?: AdbDevice;
    wifi?: AdbDevice;
    best: AdbDevice;
  };
  const map = new Map<string, Group>();
  for (const d of devices.value) {
    const key = d.device || d.model || d.serial;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label: d.model || d.serial,
        brand: d.brand || '',
        androidVersion: d.androidVersion || '',
        best: d,
      };
      map.set(key, g);
    }
    if (d.connection === 'wifi') g.wifi = d;
    else g.usb = d;
    if (d.state === 'device') g.best = d;
    if (!g.brand && d.brand) g.brand = d.brand;
    if (!g.androidVersion && d.androidVersion)
      g.androidVersion = d.androidVersion;
  }
  return [...map.values()];
});

/** 这张卡当前用哪条通道 */
/**
 * 这台手机的无线调试 IP。
 * 无线那条 adb 记录的 serial 本身就是 `ip:port`，所以不用额外跑 adb。
 * 没显示 = 这台手机还没开无线调试（或刚开、App 还在自动连 —— 3 秒轮询会补上）。
 */
function deviceIp(g: { wifi?: AdbDevice }): string {
  return g.wifi ? g.wifi.serial.replace(/:\d+$/, '') : '';
}

function activeTransport(g: {
  usb?: AdbDevice;
  wifi?: AdbDevice;
}): 'usb' | 'wifi' {
  if (g.wifi && g.wifi.serial === currentSerial.value) return 'wifi';
  if (g.usb && g.usb.serial === currentSerial.value) return 'usb';
  return g.usb ? 'usb' : 'wifi';
}

/** 卡片副标题：品牌 · Android 版本（通道由切换器表示，不在这里重复） */
function groupSubtitle(g: {
  label: string;
  brand: string;
  androidVersion: string;
}): string {
  const parts: string[] = [];
  if (g.brand) parts.push(g.brand);
  if (g.androidVersion) parts.push(`Android ${g.androidVersion}`);
  if (!parts.length) parts.push(g.label);
  return parts.join(' · ');
}

/**
 * 切换这台手机的传输方式。
 * USB → 直接切过去；WiFi 已经连过 → 切过去；
 * WiFi 还没连 → 插着线的话顺手开好（先读 IP 再 tcpip，再 connect），然后切过去。
 */
/**
 * 换通道后把投屏按新通道的参数重开。
 * USB → 1024/30fps/4Mbps；无线 → 720p/20fps/2Mbps（scrcpy-view 里按 serial 判断）。
 * 先等设备真的变成 device 再开：刚 connect / 刚拔线那一会儿，adb 里的状态可能是 offline，
 * 这时开 scrcpy 会直接报「没有可用的设备（状态必须是 device）」。
 */
async function reopenMirror(wasRunning: boolean) {
  if (!wasRunning || mirrorRunning.value) return;
  // selectDevice 只改了 currentSerial，props 要下一个 tick 才更新，先等一拍
  await new Promise((r) => setTimeout(r, 300));
  const serial = currentSerial.value;
  if (!serial) return;
  const ready = await ensureDeviceReady(serial);
  if (!ready.ok) {
    pushLog(`设备没就绪（${serial}）：${ready.why}`, 'err');
    message.warning(
      i18n.t('设备没就绪：{why}；点投屏面板上的「重试」再试', {
        why: ready.why,
      }),
    );
    return;
  }
  await restartMirror('投屏已按新通道的参数重开');
}

/**
 * 让某台设备真的可用（device 状态）。
 *
 * 为什么需要它：adbd 断过的条目会在 adb 里残留成 offline，而这种条目单靠
 * `adb connect` 不会重置（adb 只会回一句 already connected），必须先 disconnect。
 * 还是连不上就把 adb 的原话（例如 Connection refused）带出去，让用户知道真实原因。
 */
async function ensureDeviceReady(
  serial: string,
): Promise<{ ok: boolean; why: string }> {
  if (await waitForDeviceReady(serial, 2000)) return { ok: true, why: '' };
  if (!/:\d+$/.test(serial)) {
    return { ok: false, why: i18n.t('USB 设备没出现在 adb 列表里') };
  }
  const ip = serial.replace(/:\d+$/, '');
  const port = Number(serial.split(':')[1]) || 5555;
  await api.adbDisconnect(serial);
  pushLog(`重新连一次无线 ${ip}:${port}`, 'info');
  const conn = await api.adbConnect(ip, port);
  pushLog(
    `$ adb connect ${ip}:${port}\n${conn.raw || conn.message}`,
    conn.ok ? 'ok' : 'err',
  );
  if (!conn.ok) {
    if (/refused/i.test(conn.message)) {
      // 端口拒绝连接 = 手机上的 adbd 不在无线模式了，插回线才能重开
      pushLog(
        `${ip}:${port} 拒绝连接：手机上的无线调试已经被关掉了（这台手机拔线后会关）`,
        'err',
      );
    }
    return { ok: false, why: conn.message };
  }
  if (!(await waitForDeviceReady(serial, 5000))) {
    return { ok: false, why: i18n.t('连上了，但设备一直是 offline') };
  }
  return { ok: true, why: '' };
}

/**
 * 投屏面板上的「开始投屏 / 重试 / 重新连接」都走这里：
 * 先把设备弄到可用，再开投屏；日志只按真实结果写。
 */
async function retryMirror() {
  const serial = currentSerial.value;
  if (!serial) {
    message.warning(i18n.t('没有可用的设备：先插线，或点「连接」连上无线'));
    return;
  }
  const ready = await ensureDeviceReady(serial);
  if (!ready.ok) {
    pushLog(`设备没就绪（${serial}）：${ready.why}`, 'err');
    message.warning(i18n.t('设备没就绪：{why}', { why: ready.why }));
    // 不 return：还是让面板试一次，真实报错会显示在面板上
  }
  await restartMirror('投屏已接上');
}

/**
 * 等某台设备真的变成 device 状态。
 *
 * 为什么要等：刚拔线 / 刚 adb connect 那一小会儿，设备在 adb 里的状态可能还是
 * offline 或还没重新报到，这时开投屏会直接失败，而不是晚一秒自己能好。
 * 状态变化才写日志，免得每 400ms 刷一行。
 */
async function waitForDeviceReady(serial: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let shown = '';
  for (;;) {
    const res = await api.adbDevices();
    const d = (res.devices || []).find((x) => x.serial === serial);
    const state = d ? d.state : '不在列表里';
    if (d && d.state === 'device') return true;
    if (state !== shown) {
      shown = state;
      pushLog(`等设备就绪…（${serial} 现在是 ${state}）`, 'info');
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  pushLog(`等不到设备就绪（${serial} 最后状态：${shown}）`, 'err');
  return false;
}

/** 重开投屏，并且只按真实结果写日志（不猜成功） */
async function restartMirror(okMsg: string) {
  const ok = await mirrorRef.value?.start();
  if (ok) {
    pushLog(okMsg, 'info');
    return true;
  }
  pushLog(`${okMsg}——实际没接上`, 'err');
  message.warning(i18n.t('投屏没接上，点投屏面板上的「重试」试试'));
  return false;
}

async function switchTransport(
  g: { usb?: AdbDevice; wifi?: AdbDevice },
  t: 'usb' | 'wifi',
) {
  const wasRunning = mirrorRunning.value;
  if (t === 'usb') {
    let usb = g.usb;
    if (!usb) {
      // 刚跑过 tcpip（adbd 重启）的那两三秒里，USB 记录会从 adb 列表里短暂消失。
      // 所以这里不直接拒绝：先强制刷一次列表再判定。
      await loadDevices();
      const again = deviceGroups.value.find(
        (x) => x.wifi?.serial === g.wifi?.serial,
      );
      usb = again?.usb;
    }
    if (!usb) {
      message.warning(i18n.t('没找到 USB 设备：数据线插好了吗'));
      return;
    }
    if (currentSerial.value !== usb.serial) await selectDevice(usb.serial);
    await reopenMirror(wasRunning);
    return;
  }
  if (g.wifi) {
    if (currentSerial.value !== g.wifi.serial)
      await selectDevice(g.wifi.serial);
    await reopenMirror(wasRunning);
    return;
  }
  if (!g.usb) {
    message.warning(i18n.t('要先插数据线才能开启无线调试'));
    return;
  }
  // WiFi 还没连上：插着线的这台，一步开好
  busyWifi.value = true;
  try {
    let phoneIp = '';
    try {
      const ipRes = await api.adbShell(
        'ip -f inet addr show wlan0',
        g.usb.serial,
      );
      const ipText = String(ipRes.message || '');
      const m =
        ipText.match(/src\s+(\d+\.\d+\.\d+\.\d+)/) ||
        ipText.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
      if (m) phoneIp = m[1];
    } catch {
      /* 取不到就让用户手动填 */
    }
    const res = await api.adbTcpip(g.usb.serial, 5555);
    pushLog(
      res.raw ? `$ adb tcpip 5555\n${res.raw}` : res.message,
      res.ok ? 'ok' : 'err',
    );
    if (!res.ok) {
      message.error(res.message);
      return;
    }
    if (!phoneIp) phoneIp = wifiIp.value.trim();
    if (!phoneIp) {
      message.warning(i18n.t('没读到手机 IP，请用 ⚙ 手动填'));
      return;
    }
    wifiIp.value = phoneIp;
    localStorage.setItem(WIFI_IP_KEY, phoneIp);
    const conn = await api.adbConnect(phoneIp, 5555);
    pushLog(
      `$ adb connect ${phoneIp}:5555\n${conn.raw || conn.message}`,
      conn.ok ? 'ok' : 'err',
    );
    if (!conn.ok) {
      message.error(conn.message);
      return;
    }
    message.success(conn.message);
    await loadDevices();
    const wifi = devices.value.find((d) => d.connection === 'wifi');
    if (wifi) await selectDevice(wifi.serial);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    busyWifi.value = false;
  }

  // WiFi 新开的这条路径也走同一个收尾
  await reopenMirror(wasRunning);
}

async function loadDevices() {
  loadingDevices.value = true;
  const prevSerial = currentSerial.value;
  try {
    const res = await api.adbDevices();
    devices.value = res.devices || [];
    if (!res.ok) {
      pushLog(res.message, 'err');
    } else if (!devices.value.length) {
      pushLog(
        i18n.t('没有检测到设备，检查数据线和手机上的「允许 USB 调试」'),
        'err',
      );
    }
    // 自动选中第一台可以用的
    if (!devices.value.some((d) => d.serial === currentSerial.value)) {
      currentSerial.value =
        devices.value.find((d) => d.state === 'device')?.serial ||
        devices.value[0]?.serial ||
        '';
    }
  } finally {
    loadingDevices.value = false;
  }
  // 拔线了？同一台手机的无线还在的话，自动切过去并把投屏接上
  if (prevSerial && prevSerial !== currentSerial.value) {
    void handoffToWifi(prevSerial);
  }
  // 手机一插上（或列表刷新）就顺手把无线也连上 —— 不用每次手点「连接」
  void autoConnectWifi();
  // 一台可用设备都没有时，顺手看看 USB 上是不是有「插着但没开 USB 调试」的手机
  void refreshUsbHint();
}

/** 没可用设备时，读一眼 USB 描述符：手机插着但没开 USB 调试的话，在这里就能看出来 */
async function refreshUsbHint() {
  if (!api.usbScanPhones) return;
  if (devices.value.some((d) => d.state === 'device')) {
    usbPhones.value = [];
    return;
  }
  try {
    const res = await api.usbScanPhones();
    const phones = res?.supported ? res.phones || [] : [];
    // 刚插上线那几秒 adbd 在重启，ADB 接口会短暂消失（实测有 10 秒左右），
    // 直接报「没开 USB 调试」会误报 —— 隔几秒再确认一次，两次都这样才提示
    if (phones.some((x) => !x.hasAdb)) {
      await new Promise((r) => setTimeout(r, 4000));
      const again = await api.usbScanPhones();
      usbPhones.value = again?.supported ? again.phones || [] : [];
      return;
    }
    usbPhones.value = phones;
  } catch {
    usbPhones.value = [];
  }
}

/** 插着但没开 USB 调试的那台（有就提示怎么救） */
const usbStuckPhone = computed(
  () => usbPhones.value.find((p) => !p.hasAdb) || null,
);

/** 重新扫描 + 检测 USB（给提示条上的「重新检查」用） */
async function recheckDevices() {
  await loadDevices();
}

/** 重启本机 adb server：adb 卡住（插拔也认不到设备）时这么救 */
async function restartAdb() {
  if (!api.adbRestartServer) return;
  restartingAdb.value = true;
  try {
    const res = await api.adbRestartServer();
    pushLog(
      `$ adb kill-server && adb start-server\n${res.raw || res.message}`,
      res.ok ? 'ok' : 'err',
    );
    if (res.ok) message.success(i18n.t('adb 已重启，正在重新扫描'));
    else message.error(res.message);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    restartingAdb.value = false;
    await loadDevices();
  }
}

/**
 * 拔线自动切无线（只做 USB → WiFi 这个方向）。
 *
 * 触发点很巧：拔线会让 scrcpy 会话立刻结束 → 投屏组件 emit 出 running=false →
 * 我们顺手刷新一次设备列表 → 发现"当前用的那台"没了、列表自动选中了别的（那台就是无线）
 * → 于是把投屏在新设备上重新开一次。
 *
 * 为什么不在"无线断了"时反向自动切回 USB：用户可能刚点了「断开」，那是有意为之。
 */
async function handoffToWifi(prevSerial: string) {
  if (autoSwitching) return;
  const now = currentSerial.value;
  if (!/:\d+$/.test(now) || /:\d+$/.test(prevSerial)) return;
  autoSwitching = true;
  try {
    // 先别宣布「已切到无线」——等真接上了再说
    pushLog(`USB 断开，试着切到无线 ${now}…`, 'info');
    message.info(i18n.t('数据线断了，正在切到无线…'));
    const ready = await ensureDeviceReady(now);
    if (!ready.ok) {
      pushLog(
        `无线没接上：${ready.why}（这台手机一拔线就把无线调试关掉，插回线才能重开）`,
        'err',
      );
      message.error(
        i18n.t(
          '无线没接上：{why}。有些手机（比如这台）拔线后会把无线调试关掉 —— 插回数据线，点「开启」再点「连接」',
          { why: ready.why },
        ),
      );
      return;
    }
    await restartMirror('投屏已接到无线上（自动用省流模式）');
  } finally {
    autoSwitching = false;
  }
}

/**
 * 自动连无线。
 *
 * 触发时机：设备列表刷新（插线 / 切设备 / 手动刷新）之后。
 * 条件：本地存过无线 IP、列表里还没有无线设备、当前至少有一台"带线的"设备。
 * 连不上时（常见原因：手机 DHCP 换了 IP）会从插着线的那台手机**重新读一次 IP**、
 * 更新本地值再重试一遍。
 */
let autoWifiBusy = false;
let autoWifiLastTry = 0;
async function autoConnectWifi() {
  const savedIp = wifiIp.value.trim();
  if (!savedIp || autoWifiBusy) return;
  if (Date.now() - autoWifiLastTry < 5000) return; // 失败时别刷太快
  if (devices.value.some((d) => /:\d+$/.test(d.serial))) return; // 已经连着无线
  const usb = devices.value.find((d) => !/:\d+$/.test(d.serial));
  if (!usb) return; // 没插线就先不动（无线 IP 也读不到）

  autoWifiBusy = true;
  autoWifiLastTry = Date.now();
  try {
    const res = await api.adbConnect(savedIp, 5555);
    pushLog(
      `$ adb connect ${savedIp}:5555\n${res.raw || res.message}`,
      res.ok ? 'ok' : 'err',
    );
    if (res.ok) {
      await loadDevices();
      return;
    }
    // 连不上：IP 很可能变了（DHCP），从插着线的手机重新读
    const ipRes = await api.adbShell('ip -f inet addr show wlan0', usb.serial);
    const ipText = String(ipRes.message || '');
    const m =
      ipText.match(/src\s+(\d+\.\d+\.\d+\.\d+)/) ||
      ipText.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (!m || m[1] === savedIp) return;
    wifiIp.value = m[1];
    localStorage.setItem(WIFI_IP_KEY, m[1]);
    pushLog(`手机 IP 变了：${savedIp} → ${m[1]}，重试连接`, 'info');
    const again = await api.adbConnect(m[1], 5555);
    pushLog(
      `$ adb connect ${m[1]}:5555\n${again.raw || again.message}`,
      again.ok ? 'ok' : 'err',
    );
    if (again.ok) await loadDevices();
  } catch {
    /* 自动重连失败不打扰用户，下次刷新再试 */
  } finally {
    autoWifiBusy = false;
  }
}

// 手机上的「adb 安装需要确认」：true=需要确认（会弹安装界面），false=静默装
const installConfirm = ref<boolean | null>(null);

// 这台手机每次 adb shell settings 要 2~4 秒。读得慢就可能在"用户点了勾选框
// 并乐观更新"之后才返回，把旧值盖回去（实测 3 秒后被盖回 false）。
// 用序号把过期结果丢掉。
let confirmSeq = 0;

async function loadInstallConfirm() {
  const seq = ++confirmSeq;
  if (!currentSerial.value) {
    installConfirm.value = null;
    return;
  }
  const res = await api.adbGetInstallConfirm(currentSerial.value);
  if (seq !== confirmSeq) return; // 已经有更新的读取发起了，这次的结果作废
  installConfirm.value = res.ok ? res.value : null;
}

/**
 * checked 表示「跳过确认」→ 手机上那个值要设成 false。
 *
 * 先乐观更新界面：这台 HONOR 上每次 adb shell settings 要 2~4 秒，
 * 写完回读再回读一共 3 个来回 ≈ 8 秒 —— 干等的话勾选框 8 秒不动，
 * 看着像没点上。失败时才回读纠正。
 */
async function toggleSkipConfirm(checked: boolean) {
  confirmSeq += 1; // 作废在途的旧读取，别让它把刚更新的状态盖回去
  installConfirm.value = !checked;
  /**
   * 提示立刻给，不等手机那边回话。
   *
   * 改写手机设置要「写一次 + 读回来核对」，而这台手机上**每条 settings 命令本身就要
   * 1.3~1.4 秒**（实测：合并成一次 shell 也省不掉，因为是命令里的 Java 进程启动慢），
   * 所以等回读再弹提示就是快 3 秒才看到反馈，用户以为没点动。
   * 成功是常态：失败时下面会弹错误并重新读一次真实值纠正。
   */
  message.success(
    checked
      ? i18n.t('已恢复「安装需要确认」')
      : i18n.t('已关掉手机上的安装确认，之后拖进去就直接装'),
  );
  const res = await api.adbSetInstallConfirm(!checked, currentSerial.value);
  pushLog(res.message, res.ok ? 'ok' : 'err');
  if (!res.ok) {
    message.error(res.message);
    await loadInstallConfirm();
  }
}

async function selectDevice(serial: string) {
  if (serial === currentSerial.value) return;
  // 投屏投的是当前设备，换设备要先停掉（面板留着，方便在新设备上重开）
  if (mirrorRunning.value) await mirrorRef.value?.stop();
  currentSerial.value = serial;
  loadStayAwake();
  loadInstallConfirm();
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
    pushLog(
      `${i18n.t('已自动开启屏幕常亮')}（${res.state?.modes?.join('、') || ''}）`,
      'ok',
    );
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
  pushLog(
    `$ adb -s ${currentSerial.value} push ${name} → /data/local/tmp/`,
    'info',
  );
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
/* ---------------- 手机文件 ---------------- */

/** 手机上文件名可能带空格、中文、单引号，拼 shell 命令时要包好 */
function shq(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 读手机目录。
 * ls -l 在这台手机上的样子：
 *   -rw-rw---- 1 root sdcard_rw 19241417 2026-09-11 15:44 名字里可以有空格 2.docx
 * 所以按「权限 链接 属主 属组 大小 日期 时间 剩余全是名字」来切。
 */
async function loadPhoneFiles() {
  if (!currentSerial.value || !ready.value) return;
  fileLoading.value = true;
  try {
    const res = await api.adbShell(
      `ls -l ${shq(fileDir.value)}`,
      currentSerial.value,
    );
    const out: typeof fileList.value = [];
    for (const line of String(res.message || '').split('\n')) {
      const m = line.match(
        /^([-dl])[rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/,
      );
      if (!m) continue;
      const name = m[5].trim();
      if (!name || name === '.' || name === '..') continue;
      out.push({
        name,
        isDir: m[1] === 'd',
        size: Number(m[2]),
        time: `${m[3]} ${m[4]}`,
        path: `${fileDir.value}${name}`,
      });
    }
    // 文件夹在前（按名字），文件在后 —— 文件按时间降序，最新的排最上面
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (a.isDir) return a.name.localeCompare(b.name);
      // time 是 "YYYY-MM-DD HH:mm"，字符串比较就等于时间比较，倒过来就是降序
      return b.time.localeCompare(a.time);
    });
    fileList.value = out;
  } catch (err) {
    pushLog(err instanceof Error ? err.message : String(err), 'err');
  } finally {
    fileLoading.value = false;
  }
}

/** 进文件夹 */
function enterDir(item: { name: string; isDir: boolean; path: string }) {
  if (!item.isDir) return;
  fileDir.value = `${item.path}/`;
  void loadPhoneFiles();
}

/** 返回上级（不允许跑到起始目录上面去） */
function goUp() {
  const cur = fileDir.value.replace(/\/+$/, '');
  const home = homeDir.value.replace(/\/+$/, '');
  if (cur === home || !cur.startsWith(home)) {
    fileDir.value = homeDir.value;
  } else {
    const parent = cur.slice(0, cur.lastIndexOf('/'));
    fileDir.value = `${parent.length < home.length ? home : parent}/`;
  }
  void loadPhoneFiles();
}

/** 回到起始目录 */
function goHome() {
  fileDir.value = homeDir.value;
  void loadPhoneFiles();
}

/** 当前目录是不是已经到顶了（到顶就不显示「..」） */
const atHome = computed(
  () => fileDir.value.replace(/\/+$/, '') === homeDir.value.replace(/\/+$/, ''),
);

function openFiles() {
  filesOpen.value = true;
  void loadPhoneFiles();
  if (fileTimer) clearInterval(fileTimer);
  // 手机上往这个目录里放东西，这边几秒内自己就看见了
  fileTimer = setInterval(() => {
    if (filesOpen.value && !fileBusy.value) void loadPhoneFiles();
  }, 4000);
}

function closeFiles() {
  filesOpen.value = false;
  if (fileTimer) clearInterval(fileTimer);
  fileTimer = null;
}

/** 改下载位置：底部「设下载位置 / 改下载位置」按钮，随时可以重选 */
async function changeDownloadDir() {
  const pick = await api.pickDir(downloadDir.value || '');
  if (pick.canceled || !pick.dir) return;
  downloadDir.value = pick.dir;
  localStorage.setItem(DOWNLOAD_DIR_KEY, pick.dir);
  message.success(i18n.t('下载位置已设为 {dir}', { dir: pick.dir }));
}

/** 下载到电脑（主进程默认放 ~/Downloads，同名自动加序号），下完在 Finder 里指给你看 */
async function downloadPhoneFile(item: { name: string; path: string }) {
  // 只有第一次（还没设过）才弹选择框；选过一次就记住，之后直接下
  if (!downloadDir.value) {
    const pick = await api.pickDir('');
    if (pick.canceled || !pick.dir) return;
    downloadDir.value = pick.dir;
    localStorage.setItem(DOWNLOAD_DIR_KEY, pick.dir);
  }
  fileBusy.value = item.path;
  try {
    const res = await api.adbPull(item.path, downloadDir.value, currentSerial.value);
    if (res.ok) {
      pushLog(`$ adb pull ${item.path}\n  → ${res.localPath}`, 'ok');
      message.success(i18n.t(`已下载到 ${res.localPath}`));
      await api.revealPath(res.localPath);
    } else {
      message.error(res.message);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    fileBusy.value = '';
  }
}

/** 删除是破坏性的，二次确认 */
function confirmDeleteFile(item: { name: string; path: string }) {
  Modal.confirm({
    title: `${i18n.t('删除')} ${item.name} ？`,
    content: i18n.t('手机上这个文件会被真删掉，不能恢复'),
    okText: i18n.t('删除'),
    okType: 'danger',
    cancelText: i18n.t('取消'),
    async onOk() {
      fileBusy.value = item.path;
      try {
        const res = await api.adbShell(
          `rm -rf ${shq(item.path)}`,
          currentSerial.value,
        );
        pushLog(
          res.raw ? `$ rm -rf ${item.path}\n${res.raw}` : res.message,
          res.ok ? 'ok' : 'err',
        );
        if (!res.ok) {
          message.error(res.message);
          return;
        }
        message.success(i18n.t(`已删除 ${item.name}`));
        await loadPhoneFiles();
      } finally {
        fileBusy.value = '';
      }
    },
  });
}

function startRename(item: { name: string; path: string }) {
  fileRenameFrom.value = item;
  fileRenameValue.value = item.name;
  fileRenameOpen.value = true;
}

async function doRename() {
  const from = fileRenameFrom.value;
  const name = fileRenameValue.value.trim();
  if (!from || !name || name === from.name) {
    fileRenameOpen.value = false;
    return;
  }
  fileBusy.value = from.path;
  try {
    const res = await api.adbShell(
      `mv ${shq(from.path)} ${shq(fileDir.value + name)}`,
      currentSerial.value,
    );
    pushLog(
      res.raw ? `$ mv ${from.name} ${name}\n${res.raw}` : res.message,
      res.ok ? 'ok' : 'err',
    );
    if (!res.ok) {
      message.error(res.message);
      return;
    }
    message.success(i18n.t(`已改名为 ${name}`));
    fileRenameOpen.value = false;
    await loadPhoneFiles();
  } finally {
    fileBusy.value = '';
  }
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
    const res = await api.adbUninstall(
      pkg,
      currentSerial.value,
      keepData.value,
    );
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

/** 本机局域网 IP，标题栏那个 */
const localIp = ref('');

/* ---------------- monkey 压测 ---------------- */

const monkeyOpen = ref(false);
const monkeyRunning = ref(false);
const monkeyStarting = ref(false);
/** monkey 实际记录下来的动作数（不是事件数，详见 utils/monkey.ts 的注释） */
const monkeyActions = ref(0);
/** 当前跑的是哪种方式（空 = 没在跑） */
const runningMode = ref<'' | 'monkey' | 'stress'>('');
const stressProgress = ref({ done: 0, total: 0 });
const monkeyElapsed = ref(0);
let monkeyTimer: ReturnType<typeof setInterval> | null = null;

const MONKEY_KEY = 'Log Record$$monkeyConfig';
const monkeyForm = reactive({
  /** 方式：stress = 限定区域随机操作（默认），monkey = 官方 monkey */
  mode: 'stress' as 'stress' | 'monkey',
  packageName: '',
  count: 500,
  throttle: 300,
  seed: 0,
  ignoreCrashes: true,
  ignoreTimeouts: true,
  // 默认只在应用内操作：monkey 默认配比里 BACK/HOME/切应用占了很大一块，
  // 跑一会儿必然把人踢回桌面（实测 1500 事件会掉到桌面 6 次）
  stayInApp: true,
  // 默认不滑动：滑动拖到屏幕顶部会把通知栏拉下来（monkey 没有「别滑顶部」的参数，
  // 看门狗虽然能收起，但它几十毫秒又滑一次，会反复闪现）
  noSwipe: true,
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
  return s < 60
    ? `${s} ${i18n.t('秒')}`
    : `${Math.floor(s / 60)} ${i18n.t('分')} ${String(s % 60).padStart(2, '0')} ${i18n.t('秒')}`;
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
  // 限定区域模式：坐标由我们自己生成，严格限制在 App 内容区
  if (monkeyForm.mode === 'stress') {
    monkeyStarting.value = true;
    monkeyActions.value = 0;
    monkeyElapsed.value = 0;
    stressProgress.value = { done: 0, total: monkeyForm.count };
    try {
      const res = await api.stressStart({
        serial: currentSerial.value,
        packageName: monkeyForm.packageName,
        count: monkeyForm.count,
        intervalMs: monkeyForm.stressIntervalMs,
        swipeRatio: monkeyForm.stressSwipeRatio,
      });
      if (!res.ok) {
        message.error(res.message);
        return;
      }
      runningMode.value = 'stress';
      if (monkeyTimer) clearInterval(monkeyTimer);
      monkeyTimer = setInterval(() => (monkeyElapsed.value += 1), 1000);
    } finally {
      monkeyStarting.value = false;
    }
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
    runningMode.value = 'monkey';
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
  if (runningMode.value === 'stress') {
    await api.stressStop();
    return;
  }
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

/** 这个磁贴 = 手机上下载目录的映射，写死在这里 */
const pushDest = ref('/sdcard/Download/');

/* ---------------- 手机文件（电脑上直接看 / 操作手机目录） ---------------- */
const filesOpen = ref(false);
const fileLoading = ref(false);
const fileBusy = ref('');
/** 上次下载到的电脑文件夹（下次弹选择框时默认停在这儿） */
const DOWNLOAD_DIR_KEY = 'Log Record$$downloadDir';
const downloadDir = ref(localStorage.getItem(DOWNLOAD_DIR_KEY) || '');
const fileList = ref<
  { name: string; isDir: boolean; size: number; time: string; path: string }[]
>([]);
const fileRenameOpen = ref(false);
const fileRenameValue = ref('');
const fileRenameFrom = ref<{ name: string; path: string } | null>(null);
/** 起始目录（就是磁贴映射的那个目录，不让改） */
const homeDir = computed(() =>
  pushDest.value.endsWith('/') ? pushDest.value : `${pushDest.value}/`,
);
/** 当前正在看的目录：点文件夹可以进去，可以返回上级 */
const fileDir = ref(homeDir.value);
let fileTimer: ReturnType<typeof setInterval> | null = null;
// 无线调试：IP 设置的弹层
const WIFI_IP_KEY = 'Log Record$$wifiIp';
const wifiIpOpen = ref(false);

/** 设备列表里的无线设备（serial 形如 ip:5555）；没有就是空串 */
const wirelessDevice = computed(
  () => devices.value.find((d) => /:\d+$/.test(d.serial))?.serial || '',
);
const saveWifiIp = () => {
  localStorage.setItem(WIFI_IP_KEY, wifiIp.value.trim());
  wifiIpOpen.value = false;
  message.success(i18n.t('保存成功'));
};
// 自定义命令：执行后是否清空输入
const CUSTOM_CLEAR_KEY = 'Log Record$$customClearAfter';
const customClearAfter = ref(localStorage.getItem(CUSTOM_CLEAR_KEY) !== '0');
watch(customClearAfter, (v) =>
  localStorage.setItem(CUSTOM_CLEAR_KEY, v ? '1' : '0'),
);

const pushMb = computed(() => {
  const st = pushState.value;
  if (!st || !st.total) return '';
  return `${(st.bytes / 1024 / 1024).toFixed(1)} / ${(st.total / 1024 / 1024).toFixed(1)} MB`;
});

async function doPush(paths: string[], dest?: string) {
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
  pushLog(
    `${i18n.t('正在传到')} ${dest || pushDest.value}（${paths.length} 项）…`,
    'info',
  );
  try {
    const res = await api.pushFiles(
      paths,
      dest || pushDest.value,
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

async function pickAndPush(dir?: string) {
  const res = await api.pushPick();
  if (!res.canceled) await doPush(res.paths, dir);
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

/** 断开无线连接；如果当前用的就是它，切回 USB 设备（否则界面会停在已不存在的设备上） */
async function disconnectWifi() {
  const target = wirelessDevice.value;
  if (!target) return;
  busyWifi.value = true;
  try {
    const res = await api.adbDisconnect(target);
    pushLog(
      `$ adb disconnect ${target}\n${res.raw || res.message}`,
      res.ok ? 'ok' : 'err',
    );
    if (!res.ok) {
      message.error(res.message);
      return;
    }
    message.success(res.message);
    // 如果当前用的就是它，切回 USB 设备（否则界面会停在一台已经不存在的设备上）
    const wasCurrent = currentSerial.value === target;
    await loadDevices();
    if (wasCurrent) {
      const usb = devices.value.find((d) => !/:\d+$/.test(d.serial));
      if (usb) await selectDevice(usb.serial);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
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
    if (customClearAfter.value) customCmd.value = '';
  } finally {
    busyCustom.value = false;
  }
}

/* ---------------- 生命周期 ---------------- */

// 拖文件到窗口上时，Electron 默认会直接导航过去，把整页冲掉，必须全局拦掉
function blockWindowDrop(e: DragEvent) {
  e.preventDefault();
}

/* ------- 手机文件弹窗开着时，从电脑拖文件进来 = 传到手机当前目录 ------- */

const fileDropActive = ref(false);

/** 拖拽中：弹窗开着才接管，同时给列表区加投放高亮 */
function onFileDragOver(e: DragEvent) {
  e.preventDefault();
  if (!filesOpen.value) return;
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  fileDropActive.value = true;
}

/** relatedTarget 为空 = 真的拖出窗口了；在窗口内部元素之间挪动不算离开 */
function onFileDragLeave(e: DragEvent) {
  if (e.relatedTarget) return;
  fileDropActive.value = false;
}

async function onFileDrop(e: DragEvent) {
  e.preventDefault();
  if (!filesOpen.value) return;
  fileDropActive.value = false;
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
    message.warning(i18n.t('没拿到文件路径，请点「上传」按钮'));
    return;
  }
  // 传到当前打开的目录，传完重新读一次列表
  await doPush(paths, fileDir.value);
  await loadPhoneFiles();
}

let offOutput: (() => void) | null = null;

onMounted(async () => {
  window.addEventListener('dragover', blockWindowDrop);
  window.addEventListener('drop', blockWindowDrop);
  // 手机文件弹窗开着时，拖文件到窗口里直接传到当前目录
  window.addEventListener('dragover', onFileDragOver);
  window.addEventListener('dragleave', onFileDragLeave);
  window.addEventListener('drop', onFileDrop);
  if (api.onAdbOutput) {
    api.onAdbOutput((payload: { text: string }) => pushLog(payload.text));
  }
  if (api.onAdbProgress) {
    api.onAdbProgress((payload: InstallProgressState) =>
      onInstallProgress(payload),
    );
  }
  if (api.onStressOutput) {
    api.onStressOutput((line: string) => {
      const bad = /⚠️|跑出|停止/.test(line);
      pushLog(line, bad ? 'err' : 'info');
    });
  }
  if (api.onStressProgress) {
    api.onStressProgress((p: { done: number; total: number }) => {
      stressProgress.value = p;
      monkeyActions.value = p.done;
    });
  }
  if (api.onStressEscaped) {
    api.onStressEscaped((top: string) => {
      pushLog(
        `${i18n.t('跑出目标应用了（当前是')} ${top}），${i18n.t('已自动停止')}`,
        'err',
      );
      message.warning(i18n.t('跑出目标应用了，已自动停止'));
    });
  }
  if (api.onStressClosed) {
    api.onStressClosed(() => {
      monkeyRunning.value = false;
      runningMode.value = '';
      if (monkeyTimer) {
        clearInterval(monkeyTimer);
        monkeyTimer = null;
      }
    });
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
  if (api.onMonkeyEscaped) {
    api.onMonkeyEscaped((top: string) => {
      pushLog(
        `${i18n.t('monkey 跑出目标应用了（当前是')} ${top}），${i18n.t('已自动停止')}`,
        'err',
      );
      message.warning(i18n.t('monkey 跑出目标应用了，已自动停止'));
      monkeyRunning.value = false;
      if (monkeyTimer) {
        clearInterval(monkeyTimer);
        monkeyTimer = null;
      }
    });
  }
  if (api.onMonkeyClosed) {
    api.onMonkeyClosed(() => {
      monkeyRunning.value = false;
      runningMode.value = '';
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
  // 这两个都各自要跑几次 adb，串着等会让页面半天才可交互 —— 并行发出去
  loadStayAwake();
  loadInstallConfirm();
});

onActivated(() => {
  // keep-alive 缓存了页面，切回来时刷新一下设备（可能刚插线/刚拔线）
  loadDevices().then(() => {
    loadStayAwake();
    loadInstallConfirm();
  });
  // 切回来也刷一下截图记录：可能刚截过图或者删过图
  loadShotCount();
  loadLatestShot();
});

onUnmounted(() => {
  window.removeEventListener('dragover', blockWindowDrop);
  window.removeEventListener('drop', blockWindowDrop);
  window.removeEventListener('dragover', onFileDragOver);
  window.removeEventListener('dragleave', onFileDragLeave);
  window.removeEventListener('drop', onFileDrop);
  offOutput?.();
  if (fileTimer) clearInterval(fileTimer);
});

/* ---------------- 展示用 ---------------- */

function stateIcon(state: string) {
  if (state === 'device') return CheckCircleFilled;
  if (state === 'unauthorized') return ExclamationCircleFilled;
  return CloseCircleFilled;
}
function stateText(state: string) {
  if (state === 'device') return i18n.t('可用');
  if (state === 'unauthorized')
    return i18n.t('未授权，手机上点「允许 USB 调试」');
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
      <div
        class="adb-bar"
        :class="{ 'adb-bar-bad': adb && !adb.found }"
      >
        <template v-if="adb && adb.found">
          <ApiOutlined class="bar-icon" />
          <span class="bar-text">
            <span class="bar-strong">adb {{ adb.version || '未知版本' }}</span>
            <a-tooltip :title="adb.file">
              <span class="bar-path">{{ adb.file }}</span>
            </a-tooltip>
            <span class="bar-source">（{{ adb.sourceText }}）</span>
          </span>
          <a-button
            size="small"
            type="text"
            @click="pickAdb"
          >
            {{ $t('更换') }}
          </a-button>
        </template>
        <template v-else>
          <ExclamationCircleFilled class="bar-icon bar-icon-bad" />
          <span class="bar-text">{{ adb?.error || $t('没找到 adb') }}</span>
          <a-button
            size="small"
            type="primary"
            @click="pickAdb"
          >
            {{ $t('选择 adb 文件') }}
          </a-button>
          <a-tooltip :title="$t('去下载 platform-tools')">
            <a-button
              size="small"
              type="text"
              @click="
                api.openUrl(
                  'https://developer.android.com/tools/releases/platform-tools',
                )
              "
            >
              {{ $t('没装过？') }}
            </a-button>
          </a-tooltip>
        </template>
        <a-tooltip
          v-if="adb?.source === 'custom'"
          :title="$t('忘掉手动指定的，恢复自动探测')"
        >
          <a-button
            size="small"
            type="text"
            @click="resetAdb"
          >
            {{ $t('恢复自动') }}
          </a-button>
        </a-tooltip>
      </div>

      <!-- ② 设备 -->
      <div class="section-head">
        <span class="section-title">{{ $t('设备') }}</span>
        <span
          v-if="devices.length"
          class="section-count"
        >
          {{ devices.length }}
        </span>
        <a-tooltip :title="$t('重新扫描')">
          <ReloadOutlined
            class="section-action"
            :spin="loadingDevices"
            @click="loadDevices"
          />
        </a-tooltip>
        <a-tooltip
          :title="$t('认不到设备时点这里：重启本机 adb（跑久了有时会卡住）')"
        >
          <a-button
            class="section-action-btn"
            size="small"
            type="text"
            :loading="restartingAdb"
            @click="restartAdb"
          >
            {{ $t('重启 adb') }}
          </a-button>
        </a-tooltip>
      </div>

      <div
        v-if="devices.length"
        class="device-list"
      >
        <div
          v-for="g in deviceGroups"
          :key="g.key"
          class="device-card"
          :class="{
            'device-card-active':
              activeTransport(g) &&
              [g.usb, g.wifi].some((x) => x && x.serial === currentSerial),
          }"
          @click="switchTransport(g, activeTransport(g))"
        >
          <MobileOutlined class="device-icon" />
          <div class="device-info">
            <div class="device-name">{{ g.label }}</div>
            <div class="device-sub">{{ groupSubtitle(g) }}</div>
            <a-radio-group
              class="device-transport"
              size="small"
              button-style="solid"
              :value="activeTransport(g)"
              @click.stop
              @change="(e: any) => switchTransport(g, e.target.value)"
            >
              <a-radio-button value="usb">USB</a-radio-button>
              <a-radio-button value="wifi">WiFi</a-radio-button>
            </a-radio-group>
          </div>
          <div class="device-right">
            <div
              v-if="deviceIp(g)"
              class="device-net"
              :title="$t('点一下可以手动改 IP')"
              @click.stop="wifiIpOpen = true"
            >
              <LinkOutlined class="device-net-icon" />
              <span>{{ deviceIp(g) }}</span>
            </div>
            <div
              v-else
              class="device-net device-net-off"
              @click.stop="wifiIpOpen = true"
            >
              {{ $t('无线未开启') }}
            </div>
            <div
              v-if="g.wifi"
              class="device-net device-net-action"
              @click.stop="disconnectWifi()"
            >
              <DisconnectOutlined class="device-net-icon" />
              <span>{{ $t('断开') }}</span>
            </div>
            <div
              class="device-state"
              :class="'state-' + g.best.state"
            >
              <component :is="stateIcon(g.best.state)" />
              <span>{{ stateText(g.best.state) }}</span>
            </div>
          </div>
        </div>
      </div>
      <div
        v-else
        class="device-empty"
      >
        <MobileOutlined />
        <span>
          {{ $t('没检测到设备。插上数据线，手机弹「允许 USB 调试」时点允许') }}
        </span>
      </div>

      <!-- 手机插着、但没把 ADB 接口交给电脑：这是「adb 看不见手机」的头号原因 -->
      <div
        v-if="usbStuckPhone"
        class="usb-hint"
      >
        <ExclamationCircleFilled class="usb-hint-icon" />
        <div class="usb-hint-body">
          <div class="usb-hint-title">
            {{
              $t('检测到手机插着（{name}），但它没把「ADB 调试」交给电脑', {
                name: usbStuckPhone.name,
              })
            }}
          </div>
          <div class="usb-hint-line">
            {{ $t('手机上：设置 → 系统 → 开发者选项 → 打开「USB 调试」') }}
          </div>
          <div class="usb-hint-line">
            {{
              $t(
                '还不行就关掉「允许 HiSuite 通过 HDB 连接设备」，再拔插一次数据线',
              )
            }}
          </div>
        </div>
        <a-button
          size="small"
          type="primary"
          :loading="loadingDevices"
          @click="recheckDevices"
        >
          {{ $t('重新检查') }}
        </a-button>
      </div>

      <!-- ③ 功能磁贴 -->
      <div class="section-head">
        <span class="section-title">{{ $t('功能') }}</span>
      </div>

      <div class="tile-grid">
        <!-- 拖 APK 安装 -->
        <div
          class="tile tile-column"
          :class="{
            'tile-drop': dragging,
            'tile-disabled': !ready || installing,
          }"
          @dragover="onDragOver"
          @dragleave="onDragLeave"
          @drop="onDrop"
        >
          <div
            class="tile-main"
            @click="onInstallTileClick"
          >
            <div class="tile-icon">
              <LoadingOutlined
                v-if="installing"
                spin
              />
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
              <a-button
                size="small"
                danger
                class="tile-cancel"
                @click.stop="cancelInstall"
              >
                {{ $t('取消安装') }}
              </a-button>
            </template>

            <template v-else>
              <div class="tile-desc">
                {{
                  dragging
                    ? $t('松手就开始安装')
                    : $t('把 .apk 拖到这里，或点击选择')
                }}
              </div>
            </template>
          </div>

          <!-- 右：配置 -->
          <div class="tile-foot">
            <!-- 包一层 guard：antd 的 checkbox 根元素是 label，会往内部 input
               再派发一次 click，事件照样冒泡到磁贴，光在 checkbox 上写
               @click.stop 拦不住 -->
            <span
              class="tile-guard"
              @click.stop
              @mousedown.stop
            >
              <a-checkbox
                v-model:checked="autoOpen"
                class="tile-side-check"
                :disabled="!ready"
              >
                {{ $t('安装后自动打开') }}
              </a-checkbox>
            </span>
            <a-tooltip
              :title="
                $t(
                  '有些手机（比如华为荣耀）默认要求 adb 安装时在手机上点确认，勾上就免了',
                )
              "
            >
              <span
                class="tile-guard"
                @click.stop
                @mousedown.stop
              >
                <a-checkbox
                  class="tile-side-check"
                  :checked="installConfirm === false"
                  :disabled="!ready"
                  @change="(e: any) => toggleSkipConfirm(e.target.checked)"
                >
                  {{ $t('跳过安装确认') }}
                </a-checkbox>
              </span>
            </a-tooltip>
          </div>
        </div>

        <!-- 卸载应用 -->
        <div
          class="tile tile-column"
          :class="{ 'tile-disabled': !ready }"
        >
          <div
            class="tile-main"
            @click="ready && openUninstall()"
          >
            <div class="tile-icon"><DeleteOutlined /></div>
            <div class="tile-title">{{ $t('卸载应用') }}</div>
            <div class="tile-desc">{{ $t('查看手机上装的应用并卸载') }}</div>
          </div>
          <div class="tile-foot">
            <span
              class="tile-guard"
              @click.stop
              @mousedown.stop
            >
              <a-tooltip :title="$t('默认只看用户装的 App')">
                <a-checkbox
                  v-model:checked="includeSystem"
                  class="tile-side-check"
                  :disabled="!ready"
                  @change="loadPackages"
                >
                  {{ $t('显示系统应用') }}
                </a-checkbox>
              </a-tooltip>
            </span>
          </div>
        </div>

        <!-- 截图：左边截屏，右边是最近一张缩略图（点开看全部） -->
        <div
          class="tile"
          :class="{ 'tile-disabled': !ready }"
        >
          <div
            class="tile-main"
            :class="{ 'tile-half-disabled': shooting }"
            @click="ready && !shooting && takeScreenshot()"
          >
            <div class="tile-icon">
              <LoadingOutlined
                v-if="shooting"
                spin
              />
              <CameraOutlined v-else />
            </div>
            <div class="tile-title">{{ $t('截图') }}</div>
            <div class="tile-desc">
              {{ shooting ? $t('正在截图…') : $t('点这里截取手机画面') }}
            </div>
          </div>

          <div class="tile-side">
            <div
              class="tile-side-entry"
              @click="ready && openShots()"
            >
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
                  <div
                    v-else
                    class="tile-thumb tile-thumb-empty"
                  >
                    <PictureOutlined />
                  </div>
                </a-badge>
              </a-tooltip>
              <div class="tile-side-entry-label">{{ $t('截图记录') }}</div>
            </div>
          </div>
        </div>

        <!-- 屏幕常亮 -->
        <div
          class="tile tile-column"
          :class="{ 'tile-disabled': !ready || busyStayOn }"
        >
          <div
            class="tile-main"
            @click="toggleStayAwake"
          >
            <div class="tile-icon">
              <LoadingOutlined
                v-if="busyStayOn"
                spin
              />
              <BulbOutlined v-else />
            </div>
            <div class="tile-title">{{ $t('屏幕常亮') }}</div>
            <div class="tile-desc">{{ stayAwakeDesc }}</div>
            <span
              class="tile-guard"
              @click.stop
              @mousedown.stop
            >
              <a-switch
                size="small"
                :checked="!!stayAwake?.on"
                :disabled="!ready"
                :loading="busyStayOn"
                @click="toggleStayAwake"
              />
            </span>
          </div>
          <div class="tile-foot">
            <span
              class="tile-guard"
              @click.stop
              @mousedown.stop
            >
              <a-checkbox
                v-model:checked="autoStayOn"
                class="tile-side-check"
              >
                {{ $t('连接后自动开启') }}
              </a-checkbox>
            </span>
          </div>
        </div>

        <!-- 自定义命令 -->
        <div
          class="tile"
          :class="{ 'tile-disabled': !ready }"
        >
          <div class="tile-main tile-main-flat">
            <div class="tile-icon"><ThunderboltOutlined /></div>
            <div class="tile-title">{{ $t('自定义命令') }}</div>
            <div class="tile-row">
              <a-input
                v-model:value="customCmd"
                size="small"
                :placeholder="$t('例如 pm list packages -3')"
                :disabled="!ready"
                @press-enter="runCustom"
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
          <div class="tile-side">
            <span
              class="tile-guard"
              @click.stop
              @mousedown.stop
            >
              <a-tooltip :title="$t('跑完自动把输入框清空')">
                <a-checkbox
                  v-model:checked="customClearAfter"
                  class="tile-side-check"
                >
                  {{ $t('执行后清空') }}
                </a-checkbox>
              </a-tooltip>
            </span>
          </div>
        </div>

        <!-- Monkey 压测：左边开始，右边设置参数 -->
        <div
          class="tile"
          :class="{ 'tile-disabled': !ready }"
        >
          <div
            class="tile-main"
            :class="{ 'tile-half-disabled': monkeyStarting }"
            @click="ready && !monkeyStarting && toggleMonkey()"
          >
            <div class="tile-icon">
              <LoadingOutlined
                v-if="monkeyStarting"
                spin
              />
              <BugOutlined v-else />
            </div>
            <div class="tile-title">
              {{
                monkeyForm.mode === 'stress'
                  ? $t('区域随机操作')
                  : $t('Monkey 压测')
              }}
            </div>
            <div class="tile-desc">
              <template v-if="monkeyRunning">
                {{
                  runningMode === 'stress'
                    ? $t('限定区域操作中')
                    : $t('monkey 运行中')
                }}
                · {{ monkeyActions }} /
                {{ stressProgress.total || monkeyForm.count }} ·
                {{ monkeyElapsedText() }}
              </template>
              <template v-else>
                {{
                  monkeyForm.mode === 'stress'
                    ? $t('限定区域操作')
                    : $t('Monkey 压测')
                }}
                ·
                {{ $t('点这里开始跑') }}
              </template>
            </div>
          </div>
          <div class="tile-side">
            <div
              class="tile-side-entry"
              @click="openMonkeySettings"
            >
              <SettingOutlined class="tile-side-entry-icon" />
              <div class="tile-side-entry-label">{{ $t('设置参数') }}</div>
            </div>
          </div>
        </div>

        <!-- 传文件到手机 -->
        <div
          class="tile"
          :class="{
            'tile-drop': pushDragging,
            'tile-disabled': !ready,
          }"
          @dragover="onPushDragOver"
          @dragleave="onPushDragLeave"
          @drop="onPushDrop"
        >
          <div
            class="tile-main"
            @click="ready && !pushing && openFiles()"
          >
            <div class="tile-icon">
              <LoadingOutlined
                v-if="pushing"
                spin
              />
              <FolderOpenOutlined v-else />
            </div>
            <div class="tile-title">{{ $t('手机文件') }}</div>
            <template v-if="pushing">
              <a-progress
                :percent="pushState?.percent ?? 0"
                :show-info="false"
                size="small"
                class="tile-progress"
              />
              <div class="tile-desc">
                {{
                  pushState
                    ? `${pushState.index}/${pushState.count} ${pushState.name}`
                    : $t('准备中…')
                }}
              </div>
              <div class="tile-desc tile-dim">
                {{ pushMb }} · {{ $t('已用') }} {{ pushElapsed }} {{ $t('秒') }}
              </div>
              <a-button
                size="small"
                danger
                class="tile-cancel"
                @click.stop="cancelPush"
              >
                {{ $t('取消') }}
              </a-button>
            </template>
            <template v-else>
              <div class="tile-desc">{{ pushDest }}</div>
              <div class="tile-desc tile-dim">
                {{
                  pushDragging
                    ? $t('松手就传进这个目录')
                    : $t('点开看目录内容，也可以把文件拖进来')
                }}
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- ⑤ 输出 -->
      <div class="section-head">
        <span class="section-title">{{ $t('输出') }}</span>
        <a-tooltip :title="$t('清空输出')">
          <span
            class="section-action"
            @click="logs = []"
          >
            {{ $t('清空') }}
          </span>
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
            <a-checkbox
              v-model:checked="includeSystem"
              @change="loadPackages"
            >
              {{ $t('包含系统应用') }}
            </a-checkbox>
          </a-tooltip>
          <!-- 这个位置一直占着，免得提示出现/消失时表头跟着抖 -->
          <span class="un-hint">
            <template v-if="timeLoading">
              <LoadingOutlined spin />
              {{ $t('读取安装时间') }}
            </template>
            <template v-else-if="labelLoading">
              <LoadingOutlined spin />
              {{ $t('读取应用名') }}
              {{ labelProgress.done }}/{{ labelProgress.total }}
            </template>
          </span>
        </div>

        <div class="un-list">
          <div
            v-if="pkgLoading"
            class="un-empty"
          >
            <LoadingOutlined spin />
            {{ $t('读取中…') }}
          </div>
          <div
            v-else-if="!filteredPkgs.length"
            class="un-empty"
          >
            {{ $t('没有匹配的应用') }}
          </div>
          <div
            v-for="pkg in filteredPkgs"
            :key="pkg"
            class="un-item"
          >
            <div class="un-info">
              <div class="un-name">{{ appLabels[pkg] || pkg }}</div>
              <div
                v-if="appLabels[pkg]"
                class="un-pkg"
              >
                {{ pkg }}
              </div>
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

      <!-- monkey 设置 -->
      <a-modal
        v-model:open="monkeyOpen"
        :title="$t('Monkey 设置')"
        :footer="null"
        width="460px"
      >
        <div class="mk-form">
          <div class="mk-row">
            <span class="mk-label">{{ $t('方式') }}</span>
            <a-radio-group
              v-model:value="monkeyForm.mode"
              size="small"
            >
              <a-radio value="stress">{{ $t('限定区域（推荐）') }}</a-radio>
              <a-radio value="monkey">{{ $t('官方 monkey') }}</a-radio>
            </a-radio-group>
          </div>
          <div class="mk-tip">
            {{
              monkeyForm.mode === 'stress'
                ? $t(
                    '坐标由我们自己生成，严格限制在 App 内容区内 —— 不会碰到通知栏和导航栏，每次操作都落在 App 上；代价是慢一些（约 2~3 次/秒）',
                  )
                : $t(
                    '官方的 monkey：快（30+ 次/秒），但触摸坐标在整个屏幕上随机，会随机把通知栏拉下来、点到导航栏',
                  )
            }}
          </div>
          <div class="mk-row">
            <span class="mk-label">{{ $t('测试哪个应用') }}</span>
            <a-select
              v-model:value="monkeyForm.packageName"
              show-search
              size="small"
              style="flex: 1"
              :placeholder="
                pkgLoading
                  ? $t('读取应用列表…')
                  : $t('选一个应用（只列第三方）')
              "
              :options="pkgOptions"
              :loading="pkgLoading"
            />
          </div>
          <div class="mk-row">
            <span class="mk-label">{{ $t('事件数量') }}</span>
            <a-input-number
              v-model:value="monkeyForm.count"
              :min="1"
              :max="1000000"
              size="small"
              style="flex: 1"
            />
          </div>
          <div
            v-if="monkeyForm.mode === 'monkey'"
            class="mk-row"
          >
            <span class="mk-label">{{ $t('间隔（毫秒）') }}</span>
            <a-input-number
              v-model:value="monkeyForm.throttle"
              :min="0"
              :max="10000"
              size="small"
              style="flex: 1"
            />
          </div>
          <template v-else>
            <div class="mk-row">
              <span class="mk-label">{{ $t('操作间隔') }}</span>
              <a-input-number
                v-model:value="monkeyForm.stressIntervalMs"
                :min="0"
                :max="5000"
                size="small"
                style="flex: 1"
              />
              <span class="mk-hint">{{ $t('毫秒，越小越快') }}</span>
            </div>
            <div class="mk-row">
              <span class="mk-label">{{ $t('滑动比例') }}</span>
              <a-slider
                v-model:value="monkeyForm.stressSwipeRatio"
                :min="0"
                :max="1"
                :step="0.05"
                style="flex: 1"
              />
              <span class="mk-hint">
                {{ Math.round(monkeyForm.stressSwipeRatio * 100) }}%
              </span>
            </div>
          </template>
          <div class="mk-row">
            <span class="mk-label">{{ $t('随机种子') }}</span>
            <a-input-number
              v-model:value="monkeyForm.seed"
              :min="0"
              size="small"
              style="flex: 1"
            />
            <span class="mk-hint">{{ $t('留着能复现问题') }}</span>
          </div>
          <div class="mk-row">
            <a-checkbox v-model:checked="monkeyForm.ignoreCrashes">
              {{ $t('忽略崩溃继续跑') }}
            </a-checkbox>
            <a-checkbox v-model:checked="monkeyForm.ignoreTimeouts">
              {{ $t('忽略无响应继续跑') }}
            </a-checkbox>
          </div>
          <div class="mk-row">
            <a-tooltip
              :title="
                $t(
                  '通知栏只能靠从屏幕顶部往下滑拉下来，而 monkey 的滑动是随机的；不勾这个的话它会时不时把通知栏拉下来',
                )
              "
            >
              <a-checkbox v-model:checked="monkeyForm.noSwipe">
                {{ $t('不滑动（避免拉下通知栏）') }}
              </a-checkbox>
            </a-tooltip>
          </div>
          <div class="mk-row">
            <a-tooltip
              :title="
                $t(
                  'monkey 默认有相当比例的事件是 BACK/HOME/切换应用，跑一会儿就会回到桌面；勾上就只发点按滑动这类应用内操作',
                )
              "
            >
              <a-checkbox v-model:checked="monkeyForm.stayInApp">
                {{ $t('只在应用内操作（不发 BACK/HOME）') }}
              </a-checkbox>
            </a-tooltip>
          </div>
          <div class="mk-tip">
            {{
              $t(
                'monkey 会往应用里随机点按滑动，用来跑稳定性；输出里出现 CRASH 会被标红',
              )
            }}
          </div>
          <div class="mk-tip">
            {{
              $t(
                '不勾「只在应用内操作」的话，它还会按 BACK/HOME 和切换应用，那是 monkey 的默认行为',
              )
            }}
          </div>
        </div>
        <div class="mk-foot">
          <a-button
            size="small"
            @click="monkeyOpen = false"
          >
            {{ $t('取消') }}
          </a-button>
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

      <!-- 无线调试：手机 IP -->
      <!-- 手机文件：电脑上直接看和操作手机目录 -->
      <a-modal
        v-model:open="filesOpen"
        :title="$t('手机文件')"
        :footer="null"
        width="660px"
        @cancel="closeFiles"
      >
        <div class="file-bar">
          <div
            class="file-path"
            :title="fileDir"
          >
            {{ fileDir }}
          </div>
          <a-tooltip :title="$t('返回上一级')">
            <a-button
              size="small"
              :disabled="atHome"
              @click="goUp"
            >
              <ArrowUpOutlined />
            </a-button>
          </a-tooltip>
          <a-tooltip :title="$t('回到起始目录')">
            <a-button
              size="small"
              :disabled="atHome"
              @click="goHome"
            >
              <HomeOutlined />
            </a-button>
          </a-tooltip>
          <a-tooltip :title="$t('重新读一次')">
            <a-button
              size="small"
              :loading="fileLoading"
              @click="loadPhoneFiles"
            >
              <ReloadOutlined />
            </a-button>
          </a-tooltip>
          <a-button
            size="small"
            type="primary"
            :disabled="!ready"
            @click="pickAndPush(fileDir)"
          >
            <UploadOutlined />
            {{ $t('上传') }}
          </a-button>
        </div>
        <div
          class="un-list file-list"
          :class="{ 'file-drop-active': fileDropActive }"
        >
          <!-- 拖拽中：提示松手就传到当前目录 -->
          <div
            v-if="fileDropActive"
            class="file-drop-mask"
          >
            {{ $t('松手就传到') }} {{ fileDir }}
          </div>
          <div
            v-if="!fileList.length"
            class="un-empty"
          >
            {{
              fileLoading
                ? $t('读取中…')
                : $t('这个目录是空的（从电脑拖文件进来，或点右上角「上传」）')
            }}
          </div>
          <div
            v-for="f in fileList"
            :key="f.path"
            class="un-item"
            :class="{ 'file-row-dir': f.isDir }"
            @click="f.isDir && enterDir(f)"
          >
            <FolderFilled
              v-if="f.isDir"
              class="file-icon file-icon-dir"
            />
            <FileOutlined
              v-else
              class="file-icon"
            />
            <div class="un-info">
              <div
                class="un-name"
                :title="f.name"
              >
                {{ f.name }}
              </div>
              <div class="un-pkg">
                {{ f.isDir ? $t('文件夹') : fmtSize(f.size) }} · {{ f.time }}
              </div>
            </div>
            <a-tooltip :title="$t('下载到电脑')">
              <a-button
                size="small"
                type="link"
                :loading="fileBusy === f.path"
                @click.stop="downloadPhoneFile(f)"
              >
                <DownloadOutlined />
              </a-button>
            </a-tooltip>
            <a-tooltip :title="$t('重命名')">
              <a-button
                size="small"
                type="link"
                @click.stop="startRename(f)"
              >
                <EditOutlined />
              </a-button>
            </a-tooltip>
            <a-tooltip :title="$t('删除')">
              <a-button
                size="small"
                type="link"
                danger
                @click.stop="confirmDeleteFile(f)"
              >
                <DeleteOutlined />
              </a-button>
            </a-tooltip>
          </div>
        </div>
        <div class="file-foot">
          <span>{{ fileList.length }} {{ $t('项') }}</span>
          <span class="file-hint">
            {{ $t('从电脑拖文件进来即可上传；手机上放文件 4 秒内自动刷新') }}
          </span>
          <span class="file-dim">
            {{ $t('下载到') }}
            {{ downloadDir || $t('（未设置，第一次下载时让你选）') }}
          </span>
          <a-button size="small" type="link" @click="changeDownloadDir">
            {{ downloadDir ? $t('改下载位置') : $t('设下载位置') }}
          </a-button>
        </div>
      </a-modal>

      <!-- 重命名手机上的文件 -->
      <a-modal
        v-model:open="fileRenameOpen"
        :title="$t('重命名')"
        width="360px"
        @ok="doRename"
      >
        <a-input
          v-model:value="fileRenameValue"
          size="small"
          @press-enter="doRename"
        />
      </a-modal>

      <a-modal
        v-model:open="wifiIpOpen"
        :title="$t('无线调试设置')"
        :footer="null"
        width="420px"
      >
        <div class="set-item">
          <div class="set-label">{{ $t('手机 IP') }}</div>
          <a-input
            v-model:value="wifiIp"
            size="small"
            :placeholder="$t('例如 192.168.1.5')"
            @press-enter="saveWifiIp"
          />
          <div class="set-tip">
            {{ $t('插着线点「开启」时，如果手机上显示 IP 会自动填进来') }}
          </div>
        </div>
        <div class="set-foot">
          <a-button
            size="small"
            type="primary"
            @click="saveWifiIp"
          >
            {{ $t('保存') }}
          </a-button>
        </div>
      </a-modal>

      <!-- 传文件的接收目录 -->

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
              ·
              <span class="shots-unseen">
                {{ unseenCount }} {{ $t('张没看过') }}
              </span>
            </template>
          </span>
          <a-space :size="6">
            <a-button
              size="small"
              @click="wakeUp"
            >
              <ThunderboltOutlined />
              {{ $t('唤醒屏幕') }}
            </a-button>
            <a-button
              size="small"
              @click="openShotsFolder"
            >
              {{ $t('打开文件夹') }}
            </a-button>
          </a-space>
        </div>

        <div
          v-if="shotsLoading"
          class="shots-empty"
        >
          <LoadingOutlined spin />
          {{ $t('读取中…') }}
        </div>
        <div
          v-else-if="!shots.length"
          class="shots-empty"
        >
          {{ $t('还没有截图') }}
        </div>
        <div
          v-else
          class="shots-grid"
        >
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
            <div
              v-else
              class="shot-thumb shot-thumb-bad"
            >
              {{ $t('读不出来') }}
            </div>
            <span
              v-if="isShotNew(s.name)"
              class="shot-new-dot"
            >
              {{ $t('新') }}
            </span>
            <div class="shot-meta">
              <span
                class="shot-name"
                :title="s.name"
              >
                {{ s.name }}
              </span>
              <span class="shot-sub">
                {{ shotTime(s.mtime) }} · {{ shotSize(s.size) }}
              </span>
            </div>
            <div class="shot-actions">
              <a-button
                size="small"
                @click="saveShotAs(s.name)"
              >
                {{ $t('另存为') }}
              </a-button>
              <a-popconfirm
                :title="$t('删掉这张截图？')"
                :ok-text="$t('删除')"
                :cancel-text="$t('取消')"
                @confirm="deleteShot(s.name)"
              >
                <a-button
                  size="small"
                  danger
                >
                  {{ $t('删除') }}
                </a-button>
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
        <img
          :src="viewerUrl"
          class="shot-full"
        />
        <div class="shot-full-actions">
          <a-button
            size="small"
            type="primary"
            @click="saveShotAs(viewerName)"
          >
            {{ $t('另存为') }}
          </a-button>
        </div>
      </a-modal>

      <div
        ref="logBox"
        class="adb-log"
      >
        <div
          v-if="!logs.length"
          class="log-empty"
        >
          {{ $t('这里会显示每条命令的输出') }}
        </div>
        <div
          v-for="(l, i) in logs"
          :key="i"
          class="log-line"
          :class="'log-' + l.type"
        >
          {{ l.text }}
        </div>
      </div>
    </div>

    <!-- 右边：投屏面板，常驻 -->
    <div class="adb-side">
      <ScrcpyView
        ref="mirrorRef"
        :serial="currentSerial"
        @retry="retryMirror"
        @log="(t: string) => pushLog(t)"
        @running="
          (v: boolean) => {
            mirrorRunning = v;
            if (!v) void loadDevices();
          }
        "
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
.device-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

/* 右上角那个 IP：有 IP 就代表无线调试已经开着、而且 App 已连上 */
.device-net {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #336666;
}

.device-net-action {
  color: #999;
  cursor: pointer;
}

.device-net-action:hover {
  color: #c0392b;
}

.device-net {
  color: #bbb;
}

.device-transport {
  margin-top: 6px;
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
/* 手机插着但没开 USB 调试：给一条能直接照做的提示 */
.usb-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid #ffe58f;
  border-radius: 6px;
  background: #fffbe6;
}

.usb-hint-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: #d48806;
}

.usb-hint-body {
  flex: 1;
  min-width: 0;
}

.usb-hint-title {
  font-size: 13px;
  color: #874d00;
}

.usb-hint-line {
  margin-top: 4px;
  font-size: 12px;
  color: #ad6800;
}

.section-action-btn {
  padding: 0 4px;
  height: auto;
  font-size: 12px;
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
/* 统一磁贴：左边=启动（点它执行），右边=配置（这个磁贴的设置） */
.tile {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 0;
  padding: 0;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background-color: #fff;
  cursor: default;
  overflow: hidden;
  transition: all 0.2s;
}
/* 左：启动区。点这块 = 执行这个磁贴的主操作 */
.tile-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background-color 0.2s;
}
.tile-main:hover {
  background-color: #3366660d;
}
.tile-main-flat {
  cursor: default;
}
.tile-main-flat:hover {
  background-color: transparent;
}
/* 有些磁贴的配置放不进 104px 的右栏（文字会换行）：
   就改成"上面主区 + 下面一整行"。每个磁贴自己决定，不强求统一。 */
.tile-column {
  flex-direction: column;
}
.tile-foot {
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  gap: 8px;
  flex-shrink: 0;
  padding: 6px 10px;
  border-top: 1px solid #f0f0f0;
  background-color: #fafafa;
}
.tile-foot .ant-checkbox-wrapper {
  white-space: nowrap;
}
/* foot 里的入口改成横排（图标+文字），比竖排省宽度，长一点的文字也不会换行 */
.tile-foot .tile-side-entry {
  flex-direction: row;
  justify-content: center;
  gap: 6px;
  padding: 6px 8px;
}
.tile-foot .tile-side-divider {
  width: 1px;
  height: 16px;
}

/* 右：配置区。放这个磁贴的设置（开关/按钮/设置入口），宽度所有磁贴一致 */
.tile-side {
  width: 104px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 6px;
  border-left: 1px solid #f0f0f0;
  background-color: #fafafa;
}
.tile-side-head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #999;
}
.tile-side-entry {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 4px;
  border-radius: 4px;
  width: 100%;
  cursor: pointer;
  transition: background-color 0.2s;
}
.tile-side-entry:hover {
  background-color: #33666614;
  color: #336666;
}
.tile-side-entry-icon {
  font-size: 16px;
  color: #336666;
}
.tile-side-entry-label {
  font-size: 11px;
  color: #666;
  text-align: center;
  line-height: 1.25;
}
.tile-side-entry:hover .tile-side-entry-label {
  color: #336666;
}
.tile-side-check {
  font-size: 11px;
  line-height: 1.3;
  white-space: normal;
  margin: 0;
}
.tile-side-check :deep(.ant-checkbox-wrapper) {
  font-size: 11px;
  align-items: flex-start;
}
.tile-side-divider {
  width: 80%;
  height: 1px;
  background-color: #eee;
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
  max-width: 100%;
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
/* 接收目录那行：点一下就在手机上打开这个文件夹 */
.tile-open-folder {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: #999;
  max-width: 100%;
}
.tile-open-folder:hover {
  color: #336666;
}
/* 传文件磁贴底部那两个常驻按钮 */
.tile-push-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-shrink: 0;
}
.tile-push-actions :deep(.tile-push-btn) {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 12px;
  padding: 0 6px;
}
.tile-cancel {
  margin-top: 4px;
  align-self: flex-start;
}

/* ---- 截图磁贴：左右两半 ---- */
/* 兼容：老的 tile-split 现在就是普通 .tile（已经是左右两栏了） */
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
.tile-side-entry-off {
  opacity: 0.45;
  cursor: not-allowed;
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
/* 手机文件弹层 */
.file-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 8px;
  border-radius: 4px;
  background: #f7f7f7;
  color: #666;
  font-size: 12px;
  font-family: Menlo, Consolas, monospace;
}

.file-list {
  position: relative;
  max-height: 420px;
}

/* 拖文件进弹窗：列表区给出虚线投放框 */
.file-drop-active {
  border-color: #336666;
  border-style: dashed;
  background-color: #3366660d;
}

.file-drop-mask {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  background: rgba(255, 255, 255, 0.88);
  color: #336666;
  font-size: 13px;
  text-align: center;
  /* 别挡住 dragover / drop 事件 */
  pointer-events: none;
}

/* 文件夹行：能点进去 */
.file-row-dir {
  cursor: pointer;
}

.file-row-dir:hover {
  background: #f2f6f6;
}

.file-icon-dir {
  color: #e8b339;
}

.file-icon {
  flex-shrink: 0;
  color: #bbb;
}

.file-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  color: #999;
  font-size: 12px;
}

.file-dim {
  margin-left: auto;
}

/* 下载位置那一行：路径 + 设/改按钮都贴右 */
.file-dim + .ant-btn-link {
  padding: 0 2px;
  height: auto;
  font-size: 12px;
}

.un-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

/* 搜索框占掉剩下的宽度，但不许把右边的「包含系统应用」挤变形 */
.un-toolbar :deep(.ant-input-affix-wrapper) {
  flex: 1;
  min-width: 120px;
}

.un-toolbar :deep(.ant-checkbox-wrapper) {
  flex-shrink: 0;
  white-space: nowrap;
}

/* 进度提示固定占一块地方、右对齐，出现和消失都不影响别的元素 */
.un-hint {
  flex-shrink: 0;
  min-width: 116px;
  margin-left: auto;
  text-align: right;
  white-space: nowrap;
  font-size: 12px;
  color: #999;
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
