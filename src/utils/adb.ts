/**
 * adb 调用工具。
 *
 * 这里刻意不 import electron：所有跟主进程相关的东西（userData 路径、
 * 打包后的 resources 路径）都由调用方传进来，这样这个模块可以脱离
 * Electron 直接用 node 跑测试。
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** adb 是从哪找到的 */
export type AdbSource = 'custom' | 'bundled' | 'env' | 'sdk' | 'path' | 'none';

export interface AdbCandidate {
  file: string;
  source: AdbSource;
  /** 界面上显示的来源说明 */
  sourceText: string;
}

export interface AdbInfo {
  found: boolean;
  /** adb 可执行文件完整路径 */
  file: string;
  /** 形如 37.0.1；取不到就是空串 */
  version: string;
  source: AdbSource;
  sourceText: string;
  /** 找不到 / 不可用时的一句话原因 */
  error?: string;
}

export interface AdbDevice {
  serial: string;
  /** device / unauthorized / offline / bootloader … */
  state: string;
  model: string;
  product: string;
  device: string;
  connection: 'usb' | 'wifi' | 'unknown';
  /** 下面这些要额外跑一次 getprop，未授权或离线时拿不到 */
  brand?: string;
  androidVersion?: string;
  sdkVersion?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 超时被杀掉了 */
  timedOut: boolean;
}

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

/* ------------------------------------------------------------------ */
/* 查找 adb                                                            */
/* ------------------------------------------------------------------ */

/** Android SDK 的常见根目录（adb 在 <root>/platform-tools/adb） */
function sdkRoots(): string[] {
  const roots: string[] = [];
  if (process.env.ANDROID_HOME) roots.push(process.env.ANDROID_HOME);
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Android', 'sdk'));
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    roots.push(path.join(local, 'Android', 'Sdk'));
  } else {
    roots.push(path.join(home, 'Android', 'Sdk'));
    roots.push(path.join(home, 'Android', 'sdk'));
  }
  return roots;
}

/** PATH 里的所有 adb */
function pathCandidates(): string[] {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.map((d) => path.join(d, EXE));
}

/**
 * 按优先级列出所有候选位置。
 * @param customPath 用户在界面上手动指定的路径（优先级最高）
 * @param bundledDir 应用内置 adb 的目录（打包后才有）
 */
export function listAdbCandidates(
  customPath?: string,
  bundledDir?: string,
): AdbCandidate[] {
  const out: AdbCandidate[] = [];
  const push = (file: string, source: AdbSource, sourceText: string) => {
    if (file) out.push({ file, source, sourceText });
  };

  push(customPath || '', 'custom', '手动指定');
  if (bundledDir) push(path.join(bundledDir, EXE), 'bundled', '应用内置');
  for (const root of sdkRoots()) {
    const isEnv = root === process.env.ANDROID_HOME || root === process.env.ANDROID_SDK_ROOT;
    push(
      path.join(root, 'platform-tools', EXE),
      isEnv ? 'env' : 'sdk',
      isEnv ? 'ANDROID_HOME' : 'Android SDK 默认位置',
    );
  }
  for (const file of pathCandidates()) push(file, 'path', 'PATH 环境变量');
  return out;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 从 `adb version` 的输出里抠出版本号 */
export function parseAdbVersion(output: string): string {
  // 新版本：Version 37.0.1-15733141
  const modern = output.match(/Version\s+(\d+\.\d+\.\d+)/);
  if (modern) return modern[1];
  // 老版本只有：Android Debug Bridge version 1.0.41
  const legacy = output.match(/Android Debug Bridge version\s+([\d.]+)/);
  return legacy ? legacy[1] : '';
}

/**
 * 找到第一个可用的 adb 并读出它的版本。
 * 找不到时 found=false，error 里带原因。
 */
export function resolveAdb(options: {
  customPath?: string;
  bundledDir?: string;
  /** 跳过版本探测（测试用） */
  skipVersion?: boolean;
} = {}): AdbInfo {
  const candidates = listAdbCandidates(options.customPath, options.bundledDir);
  const none: AdbInfo = {
    found: false,
    file: '',
    version: '',
    source: 'none',
    sourceText: '',
  };

  if (!candidates.length) {
    return { ...none, error: '没有任何候选位置' };
  }

  // 用户手动指定的路径是「说了算」的：它坏了就直接报错，
  // 不要偷偷回退去用别的 adb —— 那样用户会以为自己的设置生效了
  if (options.customPath) {
    const custom = candidates.find((c) => c.source === 'custom')!;
    if (!isExecutable(custom.file)) {
      return {
        ...none,
        error: `指定的文件不可用（不存在或没有执行权限）：${custom.file}`,
      };
    }
    if (options.skipVersion) return { ...custom, found: true, version: '' };
    const res = runAdbSync(custom.file, ['version'], 8000);
    if (res.code !== 0) {
      return {
        ...none,
        error: `指定的文件不是可用的 adb：${custom.file}`,
      };
    }
    return { ...custom, found: true, version: parseAdbVersion(res.stdout + res.stderr) };
  }

  for (const c of candidates) {
    if (!isExecutable(c.file)) continue;
    if (options.skipVersion) {
      return { ...c, found: true, version: '' };
    }
    const res = runAdbSync(c.file, ['version'], 8000);
    if (res.code === 0) {
      return {
        ...c,
        found: true,
        version: parseAdbVersion(res.stdout + res.stderr),
      };
    }
  }

  return {
    ...none,
    error: '没找到 adb，可以手动指定它的位置',
  };
}

/* ------------------------------------------------------------------ */
/* 执行 adb                                                            */
/* ------------------------------------------------------------------ */

function spawnAdb(file: string, args: string[], timeout = 20000) {
  return spawn(file, args, {
    windowsHide: true,
    // 不加 shell：参数原样传给 adb，避免空格/特殊字符被 shell 解释
    shell: false,
  });
}

/** 同步跑一条 adb 命令（只在探测版本时用，会阻塞） */
export function runAdbSync(file: string, args: string[], timeout = 8000): RunResult {
  try {
    const stdout = execFileSync(file, args, {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout || '', stderr: '', timedOut: false };
  } catch (err: any) {
    if (err.killed || err.signal === 'SIGTERM') {
      return { code: null, stdout: '', stderr: '', timedOut: true };
    }
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : err.message || '',
      timedOut: false,
    };
  }
}

/** 跑一条 adb 命令并等它结束 */
export function runAdb(
  file: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<RunResult> {
  const timeout = options.timeout ?? 20000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ReturnType<typeof spawnAdb>;
    try {
      child = spawnAdb(file, args);
    } catch (err: any) {
      resolve({ code: 1, stdout: '', stderr: err.message || String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + (err.message || ''), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 拿二进制输出（截图用）。exec-out 是二进制安全的，不能用 shell 版。 */
export function runAdbBuffer(
  file: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ code: number | null; buffer: Buffer; stderr: string }> {
  const timeout = options.timeout ?? 30000;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    const child = spawnAdb(file, args);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, buffer: Buffer.concat(chunks), stderr: stderr + err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, buffer: Buffer.concat(chunks), stderr });
    });
  });
}

/** 流式跑 adb（安装、logcat 这种要边跑边看输出的） */
export function spawnAdbStream(
  file: string,
  args: string[],
  handlers: {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onClose?: (code: number | null) => void;
  },
) {
  const child = spawnAdb(file, args);
  child.stdout?.on('data', (d) => handlers.onStdout?.(d.toString()));
  child.stderr?.on('data', (d) => handlers.onStderr?.(d.toString()));
  child.on('error', (err) => handlers.onStderr?.(err.message || String(err)));
  child.on('close', (code) => handlers.onClose?.(code));
  return child;
}

/* ------------------------------------------------------------------ */
/* 设备                                                                */
/* ------------------------------------------------------------------ */

/** 解析 `adb devices -l` 的输出 */
export function parseDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 跳过 "* daemon started successfully *" 这类提示
    if (line.startsWith('*')) continue;
    if (line.startsWith('List of devices')) continue;
    // 跳过 "adb server version (41) doesn't match this client (40)" 之类
    if (!/^[\w.:\-]+/.test(line)) continue;

    const parts = line.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] || 'unknown';
    if (!serial || !state) continue;
    // 只认已知状态，避免把提示文字当设备
    if (!/^(device|unauthorized|offline|bootloader|recovery|sideload|no permissions)/.test(state)) {
      continue;
    }

    const extras: Record<string, string> = {};
    for (const p of parts.slice(2)) {
      const idx = p.indexOf(':');
      if (idx > 0) extras[p.slice(0, idx)] = p.slice(idx + 1);
    }

    let connection: AdbDevice['connection'] = 'unknown';
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) connection = 'wifi';
    else if (extras.usb) connection = 'usb';

    devices.push({
      serial,
      state,
      model: extras.model || '',
      product: extras.product || '',
      device: extras.device || '',
      connection,
    });
  }
  return devices;
}

/** 解析 getprop 输出：`[ro.product.brand]: [samsung]` */
export function parseGetProp(output: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
    if (m) props[m[1]] = m[2];
  }
  return props;
}

/** 列出设备，并补上品牌 / Android 版本（每个设备跑一次 getprop） */
export async function listDevices(file: string): Promise<AdbDevice[]> {
  const res = await runAdb(file, ['devices', '-l'], { timeout: 15000 });
  const devices = parseDevices(res.stdout + '\n' + res.stderr);

  await Promise.all(
    devices.map(async (d) => {
      if (d.state !== 'device') return;
      const prop = await runAdb(file, ['-s', d.serial, 'shell', 'getprop'], {
        timeout: 15000,
      });
      if (prop.code !== 0) return;
      const p = parseGetProp(prop.stdout);
      d.brand = p['ro.product.brand'] || p['ro.product.manufacturer'] || '';
      d.androidVersion = p['ro.build.version.release'] || '';
      d.sdkVersion = p['ro.build.version.sdk'] || '';
      if (!d.model) d.model = p['ro.product.model'] || '';
    }),
  );

  return devices;
}

/* ------------------------------------------------------------------ */
/* 具体动作                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 应用列表 / 卸载                                                     */
/* ------------------------------------------------------------------ */

/** 解析 `pm list packages` 输出（每行 package:com.xxx.yyy） */
export function parsePackages(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const name = t.startsWith('package:') ? t.slice('package:'.length) : t;
    // 只留像包名的，过滤掉提示文字
    if (/^[a-zA-Z][\w.]*\.[\w.]+$/.test(name)) out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 列出应用。
 * includeSystem=false 只列第三方（pm list packages -3），调式时基本只看这些。
 */
export async function listPackages(
  file: string,
  options: { serial?: string; includeSystem?: boolean } = {},
): Promise<{ ok: boolean; message?: string; packages: string[] }> {
  const args = ['shell', 'pm', 'list', 'packages'];
  if (!options.includeSystem) args.push('-3');
  if (options.serial) args.unshift('-s', options.serial);
  const res = await runAdb(file, args, { timeout: 30000 });
  if (res.code !== 0) {
    return {
      ok: false,
      message: (res.stderr || res.stdout || '读取应用列表失败').trim(),
      packages: [],
    };
  }
  return { ok: true, packages: parsePackages(res.stdout) };
}

/**
 * adb 失败时经常吐一整段 Java 堆栈（比如卸载不存在的包），
 * 直接拿来做提示会出现 "at android.os.Binder.execTransact(Binder.java:739)"
 * 这种鬼东西。这里把堆栈行滤掉，只留有意义的内容。
 */
export function firstMeaningfulLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^at\s/.test(l) &&
        !/^Exception occurred while executing/.test(l) &&
        !/^\s*Caused by/.test(l),
    );
  const failure = lines.find((l) => /Failure \[/.test(l));
  if (failure) return failure;
  // java.lang.IllegalArgumentException: Unknown package: com.x → 去掉类名前缀
  const first = lines[0] || '';
  const stripped = first.replace(/^[a-z][\w.]*\.[A-Z]\w*Exception:\s*/, '');
  return stripped || '执行失败';
}

/** 把 pm uninstall 的输出翻译成人话 */
export function judgeUninstall(output: string): { ok: boolean; message: string } {
  const text = output.trim();
  if (/^Success/m.test(text)) return { ok: true, message: '卸载成功' };
  const known: [RegExp, string][] = [
    [/Unknown package|IllegalArgumentException/, '这台设备上没装这个应用（可能已经被卸载了）'],
    [/DELETE_FAILED_DEVICE_POLICY_MANAGER/, '这个应用是设备管理器，得先去「设置 → 安全 → 设备管理器」里取消勾选才能卸'],
    [/DELETE_FAILED_INTERNAL_ERROR/, '系统内部错误，卸载失败。部分系统应用不允许卸载'],
    [/DELETE_FAILED_USER_RESTRICTED/, '系统限制了卸载'],
    [/DELETE_FAILED_OWNER_BLOCKED/, '应用被设备管理员阻止卸载'],
    [/not installed for/, '这台设备上没装这个应用'],
    [/device .* not found|no devices/, '设备断开了'],
  ];
  for (const [re, msg] of known) {
    if (re.test(text)) return { ok: false, message: msg };
  }
  if (!text) return { ok: false, message: '卸载失败，没有任何输出' };
  return { ok: false, message: firstMeaningfulLine(text) };
}

/**
 * 卸载应用。
 *
 * 一律带 --user 0：不加的话系统应用会直接失败（实测 DELETE_FAILED_INTERNAL_ERROR），
 * 加了之后系统应用能卸（只对当前用户生效，APK 还在 /system 里，可以 install-existing
 * 还原），第三方应用在单用户机器上效果和不加一样。
 * keepData=true 加 -k（保留数据和缓存），默认不保留。
 */
export async function uninstallApp(
  file: string,
  packageName: string,
  options: { serial?: string; keepData?: boolean } = {},
): Promise<{ ok: boolean; message: string; raw: string }> {
  const args = ['shell', 'pm', 'uninstall', '--user', '0'];
  if (options.keepData) args.push('-k');
  args.push(packageName);
  if (options.serial) args.unshift('-s', options.serial);

  const res = await runAdb(file, args, { timeout: 120000 });
  const raw = (res.stdout + res.stderr).trim();
  return { ...judgeUninstall(raw), raw };
}

/* ------------------------------------------------------------------ */
/* 读取 APK 信息 / 启动应用                                            */
/* ------------------------------------------------------------------ */

export interface ApkInfo {
  packageName: string;
  versionName: string;
  versionCode: string;
  label: string;
  /** 启动用的 Activity，aapt 读不到时为空 */
  launchableActivity: string;
}

/**
 * 找一个 aapt。
 * 从 adb 的路径反推 SDK 根目录（adb 一定在 <sdk>/platform-tools/adb），
 * 再去 <sdk>/build-tools/<版本>/ 里找版本号最大的那个，这样不用用户再配一次。
 */
export function findAapt(adbFile: string): string | null {
  const roots: string[] = [];
  if (adbFile) {
    const sdk = path.dirname(path.dirname(adbFile));
    roots.push(sdk);
  }
  if (process.env.ANDROID_HOME) roots.push(process.env.ANDROID_HOME);
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);

  const cmpVersion = (a: string, b: string) => {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };

  for (const root of roots) {
    const dir = path.join(root, 'build-tools');
    if (!fs.existsSync(dir)) continue;
    let versions: string[] = [];
    try {
      versions = fs.readdirSync(dir).filter((v) => !v.startsWith('.'));
    } catch {
      continue;
    }
    versions.sort(cmpVersion).reverse();
    for (const v of versions) {
      for (const name of ['aapt', 'aapt2']) {
        const file = path.join(dir, v, process.platform === 'win32' ? `${name}.exe` : name);
        if (isExecutable(file)) return file;
      }
    }
  }
  // 最后看 PATH
  for (const name of ['aapt', 'aapt2']) {
    const file = path.join(
      '',
      process.platform === 'win32' ? `${name}.exe` : name,
    );
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const f = path.join(dir, file);
      if (isExecutable(f)) return f;
    }
  }
  return null;
}

/** 解析 `aapt dump badging` 的输出 */
export function parseBadging(output: string): ApkInfo | null {
  const pkg = output.match(/^package: name='([^']*)'(.*)$/m);
  if (!pkg) return null;
  const rest = pkg[2];
  const vn = rest.match(/versionName='([^']*)'/);
  const vc = rest.match(/versionCode='([^']*)'/);
  const label = output.match(/^application-label:'([^']*)'/m);
  const act = output.match(/^launchable-activity: name='([^']*)'/m);
  return {
    packageName: pkg[1],
    versionName: vn ? vn[1] : '',
    versionCode: vc ? vc[1] : '',
    label: label ? label[1] : '',
    launchableActivity: act ? act[1] : '',
  };
}

/** 读 APK 的包名 / 版本 / 应用名 */
export function readApkInfo(aaptFile: string, apkPath: string): ApkInfo | null {
  if (!aaptFile || !fs.existsSync(apkPath)) return null;
  const res = runAdbSync(aaptFile, ['dump', 'badging', apkPath], 20000);
  if (res.code !== 0 || !res.stdout) return null;
  return parseBadging(res.stdout);
}

/** 启动应用：优先用 aapt 读到的 Activity，读不到就用 monkey 按 LAUNCHER 拉起来 */
export async function launchApp(
  file: string,
  packageName: string,
  options: { serial?: string; activity?: string } = {},
): Promise<{ ok: boolean; message: string; raw: string }> {
  const base = options.serial ? ['-s', options.serial] : [];
  const useAmStart = !!options.activity && options.activity.startsWith(packageName);

  const args = useAmStart
    ? [...base, 'shell', 'am', 'start', '-n', `${packageName}/${options.activity}`]
    : [...base, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'];

  const res = await runAdb(file, args, { timeout: 20000 });
  const raw = (res.stdout + res.stderr).trim();
  const failed =
    /Error|Exception|does not exist|No activities found|aborted/i.test(raw) ||
    res.code !== 0;
  // monkey 内部走 shell，会先打一堆 "bash arg: xxx"，报错信息在后面，
  // 不能直接取第一行，否则错误提示变成 "bash arg: -p"
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^bash arg:/.test(l));
  const errLine = lines.find((l) =>
    /Error|Exception|does not exist|No activities found|aborted/i.test(l),
  );
  return {
    ok: !failed,
    message: failed ? errLine || lines[0] || '启动失败' : '已打开',
    raw,
  };
}

/**
 * 安装成功后自动打开刚装的应用。
 * 抽成独立函数是为了能单独测：不用真的装一次包，也能验证「读包名 → 拉起应用」
 * 这条路是通的。
 */
export async function openInstalledApp(
  file: string,
  apkPath: string,
  serial?: string,
): Promise<{ ok: boolean; message: string; info: ApkInfo | null }> {
  const aapt = findAapt(file);
  if (!aapt) {
    return {
      ok: false,
      message: '没找到 aapt（在 Android SDK 的 build-tools 里），读不出包名，跳过自动打开',
      info: null,
    };
  }
  const info = readApkInfo(aapt, apkPath);
  if (!info) {
    return { ok: false, message: '没读到安装包的包名，跳过自动打开', info: null };
  }
  const res = await launchApp(file, info.packageName, {
    serial,
    activity: info.launchableActivity,
  });
  const name = info.label || info.packageName;
  return {
    ok: res.ok,
    message: res.ok ? `已打开「${name}」` : `打开了「${name}」但失败了：${res.message}`,
    info,
  };
}

/** 正在跑的安装任务，用来支持取消 */
const runningInstalls = new Map<string, { child: ReturnType<typeof spawn>; canceled: boolean }>();

/** 取消一个正在跑的安装 */
export function cancelInstall(taskId: string): boolean {
  const job = runningInstalls.get(taskId);
  if (!job) return false;
  job.canceled = true;
  try {
    job.child.kill('SIGKILL');
  } catch {
    /* 已经结束了 */
  }
  return true;
}

export interface InstallProgress {
  /** push=往手机传，install=手机上装，done=结束 */
  phase: 'push' | 'install' | 'done';
  /** 0~100，install 阶段没有百分比 */
  percent: number;
  bytes: number;
  total: number;
  text: string;
}

const INSTALL_TMP_DIR = '/data/local/tmp';
/** 传输卡住多久算死掉了 */
const PUSH_STALL_MS = 120000;
/** 传输总上限 */
const PUSH_MAX_MS = 20 * 60 * 1000;
/** 手机上安装（含 dexopt）的上限 */
const PM_INSTALL_MAX_MS = 10 * 60 * 1000;

function shellQuote(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * 安装 APK。
 *
 * 不用 `adb install`：它的 streamed install 在 Android 7~9 的老设备上会
 * 直接卡死（实测卡了 2 分 51 秒，手机侧临时目录都没建起来，传输 0 字节）。
 * 改成传统两步：先 push 到 /data/local/tmp，再 pm install，稳定而且能拿进度。
 */
export async function installApk(
  file: string,
  apkPath: string,
  options: {
    serial?: string;
    taskId?: string;
    onOutput?: (line: string) => void;
    onProgress?: (p: InstallProgress) => void;
    autoOpen?: boolean;
  } = {},
): Promise<{
  ok: boolean;
  message: string;
  raw: string;
  opened?: boolean;
  canceled?: boolean;
}> {
  const { serial, taskId, onOutput, onProgress } = options;
  if (!fs.existsSync(apkPath)) {
    return { ok: false, message: `安装包不存在：${apkPath}`, raw: '' };
  }

  let total = 0;
  try {
    total = fs.statSync(apkPath).size;
  } catch {
    /* 拿不到就算了，只是没有百分比 */
  }
  const apkName = path.basename(apkPath);
  const remote = `${INSTALL_TMP_DIR}/lr_install_${Date.now()}.apk`;
  const base = serial ? ['-s', serial] : [];

  const report = (p: InstallProgress) => {
    onProgress?.(p);
    if (p.phase !== 'push') onOutput?.(p.text + '\n');
  };

  // 清掉可能残留的同名临时文件
  await runAdb(file, [...base, 'shell', 'rm', '-f', remote], { timeout: 15000 });

  /* ---------- 第一步：push ---------- */
  report({
    phase: 'push',
    percent: 0,
    bytes: 0,
    total,
    text: `正在传输 ${apkName}（${(total / 1024 / 1024).toFixed(1)}MB）…`,
  });

  const pushResult = await new Promise<{ ok: boolean; canceled: boolean; message: string }>(
    (resolve) => {
      const child = spawnAdb(file, [...base, 'push', apkPath, remote]);
      const job = { child, canceled: false };
      if (taskId) runningInstalls.set(taskId, job);

      let stderr = '';
      let lastBytes = 0;
      let lastChange = Date.now();
      const started = Date.now();
      let settled = false;

      child.stderr?.on('data', (d) => (stderr += d.toString()));

      // adb push 在管道里不输出进度，只能自己问手机现在收到多少了
      const timer = setInterval(async () => {
        if (settled) return;
        if (Date.now() - lastChange > PUSH_STALL_MS || Date.now() - started > PUSH_MAX_MS) {
          clearInterval(timer);
          settled = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve({
            ok: false,
            canceled: false,
            message: '传输卡住了（2 分钟没有任何进度），已中止',
          });
          return;
        }
        const res = await runAdb(
          file,
          [...base, 'shell', 'stat', '-c', '%s', remote],
          { timeout: 8000 },
        );
        const size = parseInt((res.stdout || '').trim(), 10);
        if (!Number.isNaN(size) && size !== lastBytes) {
          lastBytes = size;
          lastChange = Date.now();
          const percent = total ? Math.min(99, Math.round((size / total) * 100)) : 0;
          report({
            phase: 'push',
            percent,
            bytes: size,
            total,
            text: `正在传输 ${percent}%（${(size / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB）`,
          });
        }
      }, 800);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        resolve({ ok: false, canceled: false, message: err.message || String(err) });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (taskId) runningInstalls.delete(taskId);
        if (job.canceled) {
          resolve({ ok: false, canceled: true, message: '已取消安装' });
          return;
        }
        const failedText = /No space left|couldn't create file|device offline|device not found/i.test(stderr);
        if (code === 0) {
          resolve({ ok: true, canceled: false, message: '传输完成' });
        } else if (failedText) {
          resolve({ ok: false, canceled: false, message: `传到手机失败：${stderr.trim().split('\n')[0]}` });
        } else {
          resolve({ ok: false, canceled: false, message: stderr.trim() || `传输失败（退出码 ${code}）` });
        }
      });
    },
  );

  if (!pushResult.ok) {
    await runAdb(file, [...base, 'shell', 'rm', '-f', remote], { timeout: 15000 });
    report({ phase: 'done', percent: 0, bytes: 0, total, text: pushResult.message });
    if (taskId) runningInstalls.delete(taskId);
    return { ok: false, message: pushResult.message, raw: '', canceled: pushResult.canceled };
  }

  report({
    phase: 'install',
    percent: 100,
    bytes: total,
    total,
    text: '传输完成，正在手机上安装（大包会做 dexopt，可能要一会儿）…',
  });

  /* ---------- 第二步：pm install ---------- */
  const installRes = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawnAdb(file, [
      ...base,
      'shell',
      'pm',
      'install',
      '-r',
      '-d',
      '-g',
      remote,
    ]);
    const job = { child, canceled: false };
    if (taskId) runningInstalls.set(taskId, job);

    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ code: null, output: output + '\n安装超时' });
    }, PM_INSTALL_MAX_MS);

    child.stdout?.on('data', (d) => {
      output += d.toString();
      // pm install 一般只在最后输出 Success/Failure，中途有输出就即时透传
      const text = d.toString().trim();
      if (text && !/^\s*$/.test(text)) onOutput?.(text + '\n');
    });
    child.stderr?.on('data', (d) => (output += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, output: output + (err.message || '') });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, canceled: job.canceled } as any);
    });
  });

  if ((installRes as any).canceled) {
    await runAdb(file, [...base, 'shell', 'rm', '-f', remote], { timeout: 15000 });
    if (taskId) runningInstalls.delete(taskId);
    report({ phase: 'done', percent: 0, bytes: total, total, text: '已取消安装' });
    return { ok: false, message: '已取消安装', raw: installRes.output, canceled: true };
  }

  /* ---------- 第三步：清理 ---------- */
  await runAdb(file, [...base, 'shell', 'rm', '-f', remote], { timeout: 15000 });
  if (taskId) runningInstalls.delete(taskId);

  const judged = judgeInstall(installRes.output);
  if (!judged.ok) {
    report({ phase: 'done', percent: 0, bytes: total, total, text: judged.message });
    return { ok: false, message: judged.message, raw: installRes.output };
  }
  report({ phase: 'done', percent: 100, bytes: total, total, text: judged.message });

  if (!options.autoOpen) return { ...judged, raw: installRes.output };

  const opened = await openInstalledApp(file, apkPath, serial);
  onOutput?.(`\n${opened.message}`);
  return {
    ok: true,
    message: opened.ok
      ? `${judged.message}，${opened.message}`
      : `${judged.message}（${opened.message}）`,
    raw: installRes.output,
    opened: opened.ok,
  };
}

/** 把 adb install 的失败信息翻译成人话 */
export function judgeInstall(raw: string): { ok: boolean; message: string } {
  const text = raw.trim();
  if (/\bSuccess\b/i.test(text)) return { ok: true, message: '安装成功' };

  const known: [RegExp, string][] = [
    [/INSTALL_FAILED_UPDATE_INCOMPATIBLE/, '签名不一致，手机上已装的版本签名不同，需要先卸载'],
    [/INSTALL_FAILED_VERSION_DOWNGRADE/, '手机上已装的版本更高，已加 -d 仍失败'],
    [/INSTALL_FAILED_OLDER_SDK/, '安装包的 minSdkVersion 比手机系统还高，装不上'],
    [/INSTALL_FAILED_INSUFFICIENT_STORAGE/, '手机存储空间不足'],
    [/INSTALL_FAILED_INVALID_APK/, '安装包损坏或不是合法的 APK'],
    [/INSTALL_PARSE_FAILED/, '解析安装包失败，文件可能不完整'],
    [/INSTALL_FAILED_USER_RESTRICTED/, '手机系统限制了安装（小米/华为需要在开发者选项里关掉「USB 安装限制」）'],
    [/INSTALL_FAILED_TEST_ONLY/, '这是 test-only 的包'],
    [/no devices|device .* not found/, '设备断开了，重新插一下线'],
    [/failed to stat/i, '读取安装包失败，检查文件路径'],
  ];
  for (const [re, msg] of known) {
    if (re.test(text)) return { ok: false, message: msg };
  }
  if (!text) return { ok: false, message: '安装失败，没有任何输出' };
  return { ok: false, message: firstMeaningfulLine(text) };
}

/** 截图，返回 PNG 的 Buffer */
export async function screencap(
  file: string,
  serial?: string,
): Promise<{ ok: boolean; buffer: Buffer; message: string }> {
  const args = ['exec-out', 'screencap', '-p'];
  if (serial) args.unshift('-s', serial);
  const res = await runAdbBuffer(file, args, { timeout: 30000 });

  // PNG 头是 89 50 4E 47。有些老设备/Windows 上会混进 CR，检查一下
  const isPng =
    res.buffer.length > 8 &&
    res.buffer[0] === 0x89 &&
    res.buffer[1] === 0x50 &&
    res.buffer[2] === 0x4e &&
    res.buffer[3] === 0x47;
  if (!isPng) {
    const hint = res.stderr.trim() || '截图失败';
    return { ok: false, buffer: res.buffer, message: hint };
  }
  return { ok: true, buffer: res.buffer, message: '截图成功' };
}

/** 屏幕是不是亮着。息屏时 screencap 截出来是全黑的，要提前告诉用户。 */
export async function isScreenAwake(
  file: string,
  serial?: string,
): Promise<boolean | null> {
  const args = ['shell', 'dumpsys', 'power'];
  if (serial) args.unshift('-s', serial);
  const res = await runAdb(file, args, { timeout: 15000 });
  const out = res.stdout + res.stderr;
  if (res.code !== 0 || !out.trim()) return null;
  // Android 5+：mWakefulness=Awake / Asleep / Dreaming
  const w = out.match(/mWakefulness=(\w+)/);
  if (w) return w[1] === 'Awake';
  // 老设备：Display Power: state=ON / OFF
  const d = out.match(/Display Power:\s*state=(\w+)/);
  if (d) return d[1].toUpperCase() === 'ON';
  return null;
}

/** 点亮屏幕（等价于按一下电源键，不会解锁） */
export async function wakeUp(
  file: string,
  serial?: string,
): Promise<{ ok: boolean; message: string }> {
  const args = ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'];
  if (serial) args.unshift('-s', serial);
  const res = await runAdb(file, args, { timeout: 15000 });
  const ok = res.code === 0;
  return { ok, message: ok ? '已发送唤醒指令' : (res.stderr || '唤醒失败').trim() };
}

/* 屏幕常亮（stay_on_while_plugged_in）是个位掩码 */
export const STAY_ON_BITS = { ac: 1, usb: 2, wireless: 4 } as const;

export interface StayAwakeState {
  /** 原始位掩码：0=从不，1=AC，2=USB，4=无线，7=全部 */
  value: number;
  /** 开关是否打开 */
  on: boolean;
  /** 打开时覆盖哪些充电方式 */
  modes: string[];
  /** 系统当前实际有没有在保持常亮（mStayOn）。开关开了但没插电时这里是 false */
  effective: boolean | null;
  /** 屏幕当前是否亮着 */
  awake: boolean | null;
}

/** 把位掩码翻译成人话 */
export function parseStayOnValue(value: number): { on: boolean; modes: string[] } {
  const on = value > 0;
  const modes: string[] = [];
  if (value & STAY_ON_BITS.ac) modes.push('充电器');
  if (value & STAY_ON_BITS.usb) modes.push('USB');
  if (value & STAY_ON_BITS.wireless) modes.push('无线充电');
  return { on, modes };
}

/** 读屏幕常亮状态 */
export async function getStayAwake(
  file: string,
  serial?: string,
): Promise<StayAwakeState> {
  const base = serial ? ['-s', serial] : [];
  const [setting, power] = await Promise.all([
    runAdb(file, [...base, 'shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in'], { timeout: 15000 }),
    runAdb(file, [...base, 'shell', 'dumpsys', 'power'], { timeout: 15000 }),
  ]);

  const raw = (setting.stdout + setting.stderr).trim();
  const value = /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
  const { on, modes } = parseStayOnValue(value);

  const powerText = power.stdout + power.stderr;
  const stayOn = powerText.match(/mStayOn=(true|false)/);
  const wake = powerText.match(/mWakefulness=(\w+)/);

  return {
    value,
    on,
    modes,
    effective: stayOn ? stayOn[1] === 'true' : null,
    awake: wake ? wake[1] === 'Awake' : null,
  };
}

/**
 * 开关屏幕常亮。
 * 注意 svc power stayon 只管「插电时不熄灭」，不会点亮已经黑掉的屏幕，
 * 所以打开的时候顺便唤醒一次，否则用户以为没生效。
 */
export async function setStayAwake(
  file: string,
  on: boolean,
  serial?: string,
): Promise<{ ok: boolean; message: string; raw: string; state: StayAwakeState }> {
  const base = serial ? ['-s', serial] : [];
  const res = await runAdb(
    file,
    [...base, 'shell', 'svc', 'power', 'stayon', on ? 'true' : 'false'],
    { timeout: 15000 },
  );
  const raw = (res.stdout + res.stderr).trim();
  if (on) {
    // 顺便点亮屏幕
    await runAdb(file, [...base, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], {
      timeout: 15000,
    });
  }
  const state = await getStayAwake(file, serial);
  const ok = on ? state.on : !state.on;
  return {
    ok,
    message: ok
      ? on
        ? `已开启屏幕常亮（${state.modes.join('、') || '插电时'}不熄灭）`
        : '已关闭屏幕常亮'
      : raw || '设置失败',
    raw,
    state,
  };
}

/** 打开无线调试：让手机在 5555 端口监听，之后就能拔线了 */
export async function enableTcpip(
  file: string,
  serial?: string,
  port = 5555,
): Promise<{ ok: boolean; message: string; raw: string }> {
  const args = ['tcpip', String(port)];
  if (serial) args.unshift('-s', serial);
  const res = await runAdb(file, args, { timeout: 20000 });
  const raw = (res.stdout + res.stderr).trim();
  const ok = res.code === 0 && /restarting in TCP mode|already in TCP mode/i.test(raw);
  return { ok, message: ok ? `已开启无线调试（端口 ${port}）` : raw || '开启失败', raw };
}

/** 连接无线设备 */
export async function connectWifi(
  file: string,
  address: string,
  port = 5555,
): Promise<{ ok: boolean; message: string; raw: string }> {
  const target = address.includes(':') ? address : `${address}:${port}`;
  const res = await runAdb(file, ['connect', target], { timeout: 20000 });
  const raw = (res.stdout + res.stderr).trim();
  const ok = /connected to/i.test(raw) && !/failed|refused|unable/i.test(raw);
  return {
    ok,
    message: ok ? `已连接到 ${target}` : raw || `连接 ${target} 失败`,
    raw,
  };
}

/* ------------------------------------------------------------------ */
/* 手动指定的路径持久化                                                */
/* ------------------------------------------------------------------ */

export function loadCustomAdbPath(file: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data?.path === 'string' ? data.path : '';
  } catch {
    return '';
  }
}

export function saveCustomAdbPath(file: string, adbPath: string) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ path: adbPath }, null, 2), 'utf8');
  } catch (err) {
    console.warn('保存 adb 路径失败', err);
  }
}
