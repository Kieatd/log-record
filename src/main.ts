import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  ipcMain,
  shell,
  nativeTheme,
  Menu,
  screen,
} from 'electron';
import fs from 'fs';
import { fillDebugUrl } from './utils/uiauto';
import { startMonkey, stopMonkey } from './utils/monkey';
import { cancelPush, pushFiles } from './utils/push';
import {
  injectKey,
  injectScroll,
  injectText,
  injectTouch,
  isScrcpyRunning,
  setScreenPower,
  startScrcpy,
  stopScrcpy,
} from './utils/scrcpy';
import path from 'path';
import serverClient from './server';
import { checkForUpgrade } from './utils/update';
import { name, author, version } from '../package.json';
import {
  getIPAddress,
  getIPAddressInfo,
  getIPAddressList,
} from './utils/node-strings';
import { loadWindowState, saveWindowState } from './utils/window-state';
import {
  cancelInstall,
  connectWifi,
  enableTcpip,
  findAapt,
  installApk,
  getStayAwake,
  isScreenAwake,
  listDevices,
  listPackages,
  loadCustomAdbPath,
  readInstallTimes,
  restartApp,
  readInstalledAppLabels,
  resolveAdb,
  runAdb,
  saveCustomAdbPath,
  screencap,
  setStayAwake,
  uninstallApp,
  wakeUp,
} from './utils/adb';
import started from 'electron-squirrel-startup';

if (process.platform === 'win32' && started) app.quit();

const createWindow = () => {
  // 窗口大小/位置存到 userData/window-state.json，下次打开沿用
  const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
  const { maximized, ...savedBounds } = loadWindowState(
    windowStateFile,
    screen.getAllDisplays(),
  );

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    ...savedBounds,
    titleBarStyle: 'hidden',
    titleBarOverlay: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
    transparent: true,
    icon: path.join(__dirname, '/assets/logo.png'),
  });

  // 设置标题栏颜色
  function updateTitleBarOverlay() {
    if (process.platform !== 'win32') {
      return;
    }
    mainWindow.setTitleBarOverlay({
      color: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
      symbolColor: nativeTheme.shouldUseDarkColors
        ? 'rgba(235, 235, 235, 0.64)'
        : '#2c3e50',
      height: 38,
    });
  }

  // 处理渲染进程发送的数据
  ipcMain.on('connect-phone', (_, clientIP, isAgree) => {
    serverClient.connect(clientIP, isAgree);
  });
  ipcMain.on('pause-log', (_, clientIP, isPlay) => {
    serverClient.stopCallbackLog(clientIP, isPlay);
  });

  // 初始设置
  updateTitleBarOverlay();

  // 监听主题变化
  nativeTheme.on('updated', updateTitleBarOverlay);

  ipcMain.handle('toggleDevTools', () => mainWindow.webContents.openDevTools());
  ipcMain.handle('getIPAddress', () => getIPAddress());
  // 候选地址：网卡名字判断不可能覆盖所有厂商，连不上时让用户能换一个试
  ipcMain.handle('getIPAddressList', () => getIPAddressList());
  // 可用地址 + 被排除的地址：界面上始终展示，方便确认「是不是把真网卡排除了」
  ipcMain.handle('getIPAddressInfo', () => getIPAddressInfo());
  ipcMain.handle('startScanPhone', () => {
    serverClient.scanPhone((model, clientIP) => {
      mainWindow.webContents.send('service:msg', model, clientIP);
    });
  });
  ipcMain.handle('checkIsUpdate', () =>
    checkForUpgrade(author.name, name, version),
  );










































  ipcMain.on('openUrl', (_, url) => {
    shell.openExternal(url);
  });

  /* ---------------- adb（设备 tab） ---------------- */

  // 手动指定的 adb 路径存 userData/adb.json，和窗口状态一样放主进程
  const adbPathFile = path.join(app.getPath('userData'), 'adb.json');
  // 打包后内置的 adb 放在 resources/adb/ 下（还没打进包，先留着位置）
  const bundledAdbDir = app.isPackaged
    ? path.join(process.resourcesPath, 'adb')
    : '';

  const currentAdb = () =>
    resolveAdb({
      customPath: loadCustomAdbPath(adbPathFile),
      bundledDir: bundledAdbDir,
    });

  ipcMain.handle('adb:info', () => currentAdb());

  // 手动指定：弹系统文件选择框
  ipcMain.handle('adb:pick', async () => {
    const exeName = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 adb 可执行文件',
      message: `选中 platform-tools 目录里的 ${exeName}`,
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'adb', extensions: ['exe'] }]
          : [{ name: 'adb', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, info: currentAdb() };
    }
    const picked = result.filePaths[0];
    const info = resolveAdb({ customPath: picked });
    if (info.found) {
      saveCustomAdbPath(adbPathFile, picked);
      return { canceled: false, info };
    }
    return { canceled: false, info, error: info.error };
  });

  // 传空字符串 = 清掉手动指定，回到自动探测
  ipcMain.handle('adb:setPath', (_, adbPath: string) => {
    saveCustomAdbPath(adbPathFile, adbPath || '');
    return currentAdb();
  });

  ipcMain.handle('adb:devices', async () => {
    const info = currentAdb();
    if (!info.found) return { ok: false, message: info.error || '没找到 adb', devices: [] };
    const devices = await listDevices(info.file);
    return { ok: true, devices };
  });

  ipcMain.handle(
    'adb:install',
    async (
      _,
      payload: {
        apkPath: string;
        serial?: string;
        taskId?: string;
        autoOpen?: boolean;
      },
    ) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      const send = (text: string) => {
        if (payload.taskId) {
          mainWindow.webContents.send('adb:output', {
            taskId: payload.taskId,
            text,
          });
        }
      };
      const res = await installApk(info.file, payload.apkPath, {
        serial: payload.serial,
        taskId: payload.taskId,
        onOutput: send,
        autoOpen: payload.autoOpen,
        onProgress: (p) => {
          if (payload.taskId) {
            mainWindow.webContents.send('adb:progress', {
              taskId: payload.taskId,
              ...p,
            });
          }
        },
      });
      return { ok: res.ok, message: res.message };
    },
  );

  // 拖进来或点选一个 apk（拖拽走渲染层的 webUtils，这里是点选的后备入口）
  ipcMain.handle('adb:pickApk', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择安装包',
      properties: ['openFile'],
      filters: [{ name: 'Android 安装包', extensions: ['apk'] }],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { canceled: false, apkPath: result.filePaths[0] };
  });

  /* ---------------- 截屏历史 ---------------- */

  // 截图直接落到 userData/screenshots/ 下，不再往渲染层塞大图。
  // 想看图去「截图」磁贴里的管理入口看，列表里只给缩略图。
  const shotsDir = path.join(app.getPath('userData'), 'screenshots');
  const ensureShotsDir = () => {
    if (!fs.existsSync(shotsDir)) fs.mkdirSync(shotsDir, { recursive: true });
    return shotsDir;
  };
  const shotPath = (name: string) => path.join(shotsDir, path.basename(name));

  /** 文件名：机型_年月日_时分秒.png，按名字排序就是按时间排序 */
  const shotName = (model: string, date = new Date()) => {
    const p = (n: number) => String(n).padStart(2, '0');
    const safe = (model || 'device').replace(/[^\w.-]/g, '_');
    return `${safe}_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.png`;
  };

  const listShots = () => {
    ensureShotsDir();
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(shotsDir)
        .filter((f) => f.toLowerCase().endsWith('.png'));
    } catch {
      return [];
    }
    return names
      .map((name) => {
        const full = shotPath(name);
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* ignore */
        }
        return { name, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // 新的在前
  };

  // 顺便把文件名带回去：渲染层要拿它和「已查看」列表比对，算出未读数。
  // 这里不生成缩略图，所以很便宜，可以随便调。
  ipcMain.handle('shots:count', () => {
    const shots = listShots();
    return { count: shots.length, names: shots.map((s) => s.name) };
  });

  // 给列表用的小缩略图（原图 1080x2220 有 1MB 多，直接传会很卡）
  ipcMain.handle('shots:list', () => {
    const shots = listShots().map((item) => {
      let thumb = '';
      try {
        const img = nativeImage.createFromPath(shotPath(item.name));
        if (!img.isEmpty()) {
          thumb = img.resize({ width: 220, quality: 'good' }).toDataURL();
        }
      } catch {
        /* ignore */
      }
      return { ...item, thumb };
    });
    return { shots };
  });

  // 只给最近一张的小缩略图：磁贴右边那一半要用。
  // 单独开一个接口是因为 shots:list 会把每张都生成一遍缩略图，太重。
  ipcMain.handle('shots:latest', () => {
    const newest = listShots()[0];
    if (!newest) return { ok: true, name: '', thumb: '' };
    let thumb = '';
    try {
      const img = nativeImage.createFromPath(shotPath(newest.name));
      if (!img.isEmpty()) {
        thumb = img.resize({ width: 160, quality: 'good' }).toDataURL();
      }
    } catch {
      /* ignore */
    }
    return { ok: true, name: newest.name, thumb };
  });

  ipcMain.handle('shots:read', (_, name: string) => {
    const full = shotPath(name);
    if (!fs.existsSync(full)) return { ok: false, message: '图片不在了' };
    const img = nativeImage.createFromPath(full);
    if (img.isEmpty()) return { ok: false, message: '读不出这张图' };
    return { ok: true, dataUrl: img.toDataURL() };
  });

  ipcMain.handle('shots:saveAs', async (_, name: string) => {
    const full = shotPath(name);
    if (!fs.existsSync(full)) return { ok: false, message: '图片不在了' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存截图',
      defaultPath: name,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.promises.copyFile(full, result.filePath);
    return { ok: true, filePath: result.filePath };
  });

  ipcMain.handle('shots:delete', (_, name: string) => {
    try {
      fs.unlinkSync(shotPath(name));
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shots:openFolder', () => {
    shell.openPath(ensureShotsDir());
    return { ok: true };
  });

  ipcMain.handle('adb:screencap', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
    // 息屏时截出来是全黑的，先说清楚，不然用户以为截图坏了
    const awake = await isScreenAwake(info.file, serial);
    const shot = await screencap(info.file, serial);
    if (!shot.ok) return { ok: false, message: shot.message };

    // 存到本地，返回文件名（不给渲染层传大图）
    let saved = '';
    try {
      ensureShotsDir();
      const devices = await listDevices(info.file);
      const model = devices.find((d) => d.serial === serial)?.model || '';
      saved = shotName(model);
      fs.writeFileSync(shotPath(saved), shot.buffer);
    } catch (err) {
      console.warn('保存截图失败', err);
    }

    return {
      ok: true,
      message: '截图成功',
      screenAwake: awake,
      name: saved,
      count: listShots().length,
    };
  });

  ipcMain.handle(
    'adb:packages',
    async (_, payload: { serial?: string; includeSystem?: boolean } = {}) => {
      const info = currentAdb();
      if (!info.found) {
        return { ok: false, message: info.error || '没找到 adb', packages: [] };
      }
      return listPackages(info.file, payload);
    },
  );

  /* ---------------- 重启一个 App（填完调试地址要用） ---------------- */

  ipcMain.handle(
    'app:restart',
    async (_, payload: { packageName: string; serial?: string }) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      return restartApp(info.file, payload.packageName, payload.serial);
    },
  );

  /* ---------------- 一键填调试地址（UI 自动化） ---------------- */

  ipcMain.handle(
    'uiauto:fillDebugUrl',
    async (
      _,
      payload: {
        ip: string;
        serial?: string;
        buttonText?: string;
        screenKey?: string;
        force?: boolean;
        packageName?: string;
        navSteps?: string[];
      },
    ) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb', steps: [] };
      return fillDebugUrl(info.file, payload);
    },
  );

  ipcMain.handle('adb:installTimes', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found) return { ok: false, message: info.error || '没找到 adb', times: {} };
    return readInstallTimes(info.file, serial);
  });

  // 批量读已装应用的「应用名」。安卓的应用名藏在 APK 的 resources.arsc 里，
  // 主进程负责抽出相关文件、拼最小 zip 再交给 aapt，渲染层只管收结果。
  ipcMain.handle(
    'adb:appLabels',
    async (_, payload: { items: { packageName: string; apkPath: string }[]; serial?: string }) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, labels: [] };
      const aapt = findAapt(info.file);
      if (!aapt) return { ok: false, message: '没找到 aapt，读不到应用名', labels: [] };
      const labels = await readInstalledAppLabels(info.file, aapt, payload.items || [], {
        serial: payload.serial,
      });
      return { ok: true, labels };
    },
  );

  ipcMain.handle(
    'adb:uninstall',
    async (_, payload: { packageName: string; serial?: string; keepData?: boolean }) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      return uninstallApp(info.file, payload.packageName, {
        serial: payload.serial,
        keepData: payload.keepData,
      });
    },
  );

  /* ---------------- scrcpy 投屏 / 操控 ---------------- */

  // scrcpy-server 随应用打包。asar 里只有 Vite 产物，二进制是用
  // forge 的 extraResource 单独带出去的，所以打包后要去 resourcesPath 找。
  const scrcpyServerFile = app.isPackaged
    ? path.join(process.resourcesPath, 'scrcpy-server.bin')
    : path.join(app.getAppPath(), 'resources', 'scrcpy-server.bin');

  ipcMain.handle('scrcpy:status', () => ({
    running: isScrcpyRunning(),
    serverFile: scrcpyServerFile,
  }));

  ipcMain.handle(
    'scrcpy:start',
    async (_, payload: { serial?: string; maxSize?: number; maxFps?: number }) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      return startScrcpy({
        serial: payload?.serial,
        serverFile: scrcpyServerFile,
        maxSize: payload?.maxSize ?? 1024,
        maxFps: payload?.maxFps ?? 30,
        onMeta: (meta) => {
          mainWindow.webContents.send('scrcpy:meta', meta);
        },
        onPacket: (packet) => {
          // 视频包直接转给渲染进程解码（H.264 裸流，WebCodecs 解）
          mainWindow.webContents.send('scrcpy:packet', packet);
        },
        onLog: (line) => {
          mainWindow.webContents.send('scrcpy:log', line);
        },
        onError: (message) => {
          mainWindow.webContents.send('scrcpy:error', message);
        },
        onClose: (reason) => {
          mainWindow.webContents.send('scrcpy:closed', reason);
        },
      });
    },
  );

  ipcMain.handle('scrcpy:stop', async () => {
    await stopScrcpy();
    return { ok: true };
  });

  ipcMain.handle('scrcpy:touch', (_, payload: any) => injectTouch(payload));
  ipcMain.handle('scrcpy:scroll', (_, payload: any) => injectScroll(payload));
  ipcMain.handle('scrcpy:key', (_, payload: any) => injectKey(payload));
  ipcMain.handle('scrcpy:text', (_, text: string) => injectText(text));
  ipcMain.handle('scrcpy:power', (_, on: boolean) => setScreenPower(on));

  /* ---------------- monkey 压测 ---------------- */

  ipcMain.handle(
    'monkey:start',
    (
      _,
      payload: {
        serial?: string;
        packageName?: string;
        count?: number;
        throttle?: number;
        seed?: number;
        ignoreCrashes?: boolean;
        ignoreTimeouts?: boolean;
      },
    ) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      return startMonkey(info.file, {
        ...payload,
        onOutput: (line) => mainWindow.webContents.send('monkey:output', line),
        onEvent: (n) => mainWindow.webContents.send('monkey:event', n),
        onClose: (code) => mainWindow.webContents.send('monkey:closed', code),
        onEscaped: (top) => mainWindow.webContents.send('monkey:escaped', top),
      });
    },
  );

  ipcMain.handle('monkey:stop', async () => {
    const info = currentAdb();
    await stopMonkey(info.found ? info.file : undefined, undefined);
    return { ok: true };
  });

  /* ---------------- 快速传文件 ---------------- */

  ipcMain.handle('push:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要传到手机的文件',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { canceled: false, paths: result.filePaths };
  });

  ipcMain.handle(
    'push:files',
    async (
      _,
      payload: { paths: string[]; dest?: string; serial?: string; taskId?: string },
    ) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      return pushFiles(info.file, payload.paths || [], {
        serial: payload.serial,
        taskId: payload.taskId,
        dest: payload.dest || '/sdcard/Download/',
        onOutput: (line) => mainWindow.webContents.send('push:output', line),
        onProgress: (p) => {
          if (payload.taskId) {
            mainWindow.webContents.send('push:progress', { taskId: payload.taskId, ...p });
          }
        },
      });
    },
  );

  ipcMain.handle('push:cancel', (_, taskId: string) => ({
    ok: cancelPush(taskId),
  }));

  ipcMain.handle('adb:cancelInstall', (_, taskId: string) =>
    cancelInstall(taskId),
  );

  ipcMain.handle('adb:stayAwake', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found) {
      return { ok: false, message: info.error || '没找到 adb', state: null };
    }
    return { ok: true, state: await getStayAwake(info.file, serial) };
  });

  ipcMain.handle(
    'adb:setStayAwake',
    async (_, payload: { on: boolean; serial?: string }) => {
      const info = currentAdb();
      if (!info.found) {
        return { ok: false, message: info.error || '没找到 adb', state: null };
      }
      return setStayAwake(info.file, payload.on, payload.serial);
    },
  );

  ipcMain.handle('adb:wakeup', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
    return wakeUp(info.file, serial);
  });

  // 保存截图到本地
  ipcMain.handle(
    'adb:saveImage',
    async (_, payload: { dataUrl: string; defaultName: string }) => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存截图',
        defaultPath: payload.defaultName,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const base64 = payload.dataUrl.replace(/^data:image\/\w+;base64,/, '');
      await fs.promises.writeFile(result.filePath, Buffer.from(base64, 'base64'));
      return { canceled: false, filePath: result.filePath };
    },
  );

  ipcMain.handle(
    'adb:tcpip',
    async (_, payload: { serial?: string; port?: number }) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      return enableTcpip(info.file, payload.serial, payload.port ?? 5555);
    },
  );

  ipcMain.handle(
    'adb:connect',
    async (_, payload: { address: string; port?: number }) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      return connectWifi(info.file, payload.address, payload.port ?? 5555);
    },
  );

  // 通用 shell（输出面板的「自定义命令」用）
  ipcMain.handle(
    'adb:shell',
    async (_, payload: { command: string; serial?: string }) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
      const args = ['shell', ...payload.command.split(' ').filter(Boolean)];
      if (payload.serial) args.unshift('-s', payload.serial);
      const res = await runAdb(info.file, args, { timeout: 30000 });
      const output = (res.stdout + res.stderr).trim();
      return {
        ok: res.code === 0,
        message: output || (res.code === 0 ? '执行完成' : '执行失败'),
      };
    },
  );

  // 重新请求：由主进程发出去（渲染进程发会受 CORS 限制）
  ipcMain.handle(
    'sendRequest',
    async (
      _,
      options: {
        method?: string;
        url: string;
        headers?: Record<string, string>;
        body?: string;
        timeout?: number;
      },
    ) => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        options.timeout ?? 15000,
      );
      try {
        const method = (options.method ?? 'GET').toUpperCase();
        // GET/HEAD 不允许带 body，带了 fetch 会直接报错
        const canHaveBody = !['GET', 'HEAD'].includes(method);
        const response = await fetch(options.url, {
          method,
          headers: options.headers ?? {},
          body: canHaveBody && options.body ? options.body : undefined,
          signal: controller.signal,
          redirect: 'follow',
        });
        const text = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          ok: true,
          statusCode: response.status,
          statusText: response.statusText,
          headers,
          body: text,
          durationMs: Date.now() - started,
        };
      } catch (err: any) {
        return {
          ok: false,
          error:
            err?.name === 'AbortError'
              ? '请求超时'
              : (err?.message ?? String(err)),
          durationMs: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  );

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.on('ready-to-show', () => {
    serverClient.startListen({
      '/log': (msg) => {
        mainWindow.webContents.send('log:msg', msg);
      },
      '/network': (msg) => {
        mainWindow.webContents.send('network:msg', msg);
      }
    });
  });

  Menu.setApplicationMenu(null);

  if (maximized) {
    mainWindow.maximize();
  }

  // 拖动/缩放窗口时保存（防抖：拖的过程中会不断触发 resize）
  let saveTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // 最大化/全屏时 getBounds 会返回占满屏幕的尺寸，存这个没意义
    if (mainWindow.isMinimized()) {
      return;
    }
    saveWindowState(windowStateFile, {
      ...mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized(),
    });
  };
  const debouncedPersist = () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(persistBounds, 400);
  };
  mainWindow.on('resize', debouncedPersist);
  mainWindow.on('move', debouncedPersist);
  // 关闭前再存一次，避免防抖还没触发就退出了
  mainWindow.on('close', persistBounds);
};

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', async () => {
  await serverClient.unpublish();
  await serverClient.destroy();
  await serverClient.stopListen();
  app.exit(0);
});
