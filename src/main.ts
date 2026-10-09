import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeImage,
  ipcMain,
  shell,
  nativeTheme,
  Menu,
  screen,
} from 'electron';
import fs from 'fs';
import { openFolderOnPhone } from './utils/uiauto';
import { startMonkey, stopMonkey } from './utils/monkey';
import { isStressRunning, startStress, stopStress } from './utils/stress';
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
import {
  isBoundsVisible,
  loadWindowState,
  saveWindowState,
} from './utils/window-state';
import { scanUsbPhones } from './utils/usb-scan';
import {
  pullFromPhone,
  cancelInstall,
  findAapt,
  installApk,
  getStayAwake,
  isScreenAwake,
  listDevices,
  listPackages,
  loadCustomAdbPath,
  getInstallConfirm,
  setInstallConfirm,
  readInstallTimes,
  readPhoneStats,
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
  const windowStateFile = path.join(
    app.getPath('userData'),
    'window-state.json',
  );
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
      // 窗口被别的窗口挡住 / 最小化时，Electron 默认会把渲染层的定时器降到 1 秒一次。
      // 投屏的拖动采样是按 7ms 定时器补点的（见 scrcpy-view.vue 的 sampleTick），
      // 被节流之后采样点会变成每秒一个，手机上直接算不出滑动 —— 必须关掉。
      backgroundThrottling: false,
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

  ipcMain.handle('adb:getInstallConfirm', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found) return { ok: false, value: null };
    return { ok: true, value: await getInstallConfirm(info.file, serial) };
  });

  ipcMain.handle(
    'adb:setInstallConfirm',
    async (_, payload: { on: boolean; serial?: string }) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, message: '没找到 adb' };
      return setInstallConfirm(info.file, payload.on, payload.serial);
    },
  );

  ipcMain.handle('adb:devices', async () => {
    const info = currentAdb();
    if (!info.found)
      return { ok: false, message: info.error || '没找到 adb', devices: [] };
    const devices = await listDevices(info.file);
    return { ok: true, devices };
  });

  /**
   * 重启本机 adb server。
   * 场景：adb server 跑久了会卡住 —— 手机插着、描述符也正常，但它就是认不到，
   * 插拔也没用，只能 kill-server + start-server 重启。
   */
  ipcMain.handle('adb:restartServer', async () => {
    const info = currentAdb();
    if (!info.found)
      return { ok: false, message: info.error || '没找到 adb', raw: '' };
    await runAdb(info.file, ['kill-server'], { timeout: 10000 });
    const res = await runAdb(info.file, ['start-server'], { timeout: 20000 });
    const raw = `${res.stdout || ''}${res.stderr || ''}`.trim();
    return {
      ok: res.code === 0,
      message: res.code === 0 ? 'adb 已重启' : raw || 'adb 重启失败',
      raw,
    };
  });

  /** 投屏时显示的手机占用：CPU / 内存 / 温度 / GPU 频率（一次 shell 全取回） */
  ipcMain.handle('adb:phoneStats', async (_, payload: { serial?: string }) => {
    const info = currentAdb();
    if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
    return readPhoneStats(info.file, payload.serial);
  });

  /**
   * 只看一眼 Mac 的 USB 总线：有没有「手机插着但没开 USB 调试」。
   * 只读描述符，不碰设备，不用 adb。
   */
  ipcMain.handle('usb:scanPhones', () => scanUsbPhones());

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
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
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
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
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

  // 在手机上打开一个文件夹（用手机自己的文件管理器）
  ipcMain.handle(
    'adb:openFolder',
    async (_, payload: { folder: string; serial?: string }) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
      return openFolderOnPhone(info.file, payload.folder, payload.serial);
    },
  );

  /* ---------------- 重启一个 App（填完调试地址要用） ---------------- */

  ipcMain.handle(
    'app:restart',
    async (_, payload: { packageName: string; serial?: string }) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
      return restartApp(info.file, payload.packageName, payload.serial);
    },
  );

  ipcMain.handle('adb:installTimes', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found)
      return { ok: false, message: info.error || '没找到 adb', times: {} };
    return readInstallTimes(info.file, serial);
  });

  // 批量读已装应用的「应用名」。安卓的应用名藏在 APK 的 resources.arsc 里，
  // 主进程负责抽出相关文件、拼最小 zip 再交给 aapt，渲染层只管收结果。
  ipcMain.handle(
    'adb:appLabels',
    async (
      _,
      payload: {
        items: { packageName: string; apkPath: string }[];
        serial?: string;
      },
    ) => {
      const info = currentAdb();
      if (!info.found) return { ok: false, labels: [] };
      const aapt = findAapt(info.file);
      if (!aapt)
        return { ok: false, message: '没找到 aapt，读不到应用名', labels: [] };
      const labels = await readInstalledAppLabels(
        info.file,
        aapt,
        payload.items || [],
        {
          serial: payload.serial,
        },
      );
      return { ok: true, labels };
    },
  );

  ipcMain.handle(
    'adb:pull',

    async (
      _,

      payload: { remotePath: string; destDir: string; serial?: string },
    ) => {
      const info = currentAdb();

      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };

      return pullFromPhone(info.file, payload.remotePath, payload.destDir, {
        serial: payload.serial,
      });
    },
  );

  // 在电脑的文件管理器里把这个文件/目录显示出来

  // 让用户挑一个电脑上的文件夹（下载到电脑时用）
  ipcMain.handle('app:pickDir', async (_, defaultPath?: string) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要下载到的文件夹',
      defaultPath: defaultPath || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '下载到这里',
    });
    if (res.canceled || !res.filePaths.length) {
      return { canceled: true, dir: '' };
    }
    return { canceled: false, dir: res.filePaths[0] };
  });

  ipcMain.handle('app:revealPath', (_, target: string) => {
    try {
      shell.showItemInFolder(target);

      return { ok: true };
    } catch (err) {
      return {
        ok: false,

        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(
    'adb:uninstall',
    async (
      _,
      payload: { packageName: string; serial?: string; keepData?: boolean },
    ) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
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

  /* ---------------- 独立投屏浮窗（真窗口：能拖到桌面任何地方） ---------------- */

  let mirrorWindow: BrowserWindow | null = null;
  /** 浮窗里投屏是否在跑（召回时用来自动接着投） */
  let mirrorWindowRunning = false;
  const mirrorStateFile = path.join(
    app.getPath('userData'),
    'mirror-window.json',
  );

  /** 投屏数据包发到哪儿：浮窗开着就发浮窗，否则发主窗口 */
  function mirrorTarget(): Electron.WebContents {
    if (mirrorWindow && !mirrorWindow.isDestroyed()) {
      return mirrorWindow.webContents;
    }
    return mainWindow.webContents;
  }

  function loadMirrorBounds(): {
    x?: number;
    y?: number;
    width: number;
    height: number;
  } {
    try {
      const b = JSON.parse(fs.readFileSync(mirrorStateFile, 'utf-8'));
      if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) {
        const width = Math.max(240, Math.round(b.width));
        const height = Math.max(320, Math.round(b.height));
        const onScreen = isBoundsVisible(
          { x: b.x, y: b.y, width, height },
          screen.getAllDisplays(),
        );
        if (onScreen) {
          return { x: Math.round(b.x), y: Math.round(b.y), width, height };
        }
        return { width, height };
      }
    } catch {
      /* 第一次打开：还没有存档 */
    }
    // 默认就是主窗口里那块面板的大小（手机竖屏）
    return { width: 340, height: 620 };
  }

  function saveMirrorBounds(bounds: Electron.Rectangle) {
    try {
      fs.writeFileSync(mirrorStateFile, JSON.stringify(bounds), 'utf-8');
    } catch (err) {
      console.warn('保存投屏浮窗位置失败', err);
    }
  }

  /** 开浮窗；已经开着就把它拉到前面（不重复开） */
  async function openMirrorWindow(payload: {
    serial?: string;
    width?: number;
    height?: number;
  }): Promise<{ ok: boolean }> {
    if (mirrorWindow && !mirrorWindow.isDestroyed()) {
      mirrorWindow.show();
      mirrorWindow.focus();
      return { ok: true };
    }
    const saved = loadMirrorBounds();
    const width = Math.max(240, Math.round(payload.width || saved.width));
    const height = Math.max(320, Math.round(payload.height || saved.height));
    mirrorWindow = new BrowserWindow({
      width,
      height,
      x: saved.x,
      y: saved.y,
      minWidth: 240,
      minHeight: 320,
      frame: false, // 无边框：顶上那条拖动栏是自己画的
      title: 'Log Record 投屏浮窗',
      alwaysOnTop: true, // 可以盖在别的软件上面
      skipTaskbar: false,
      resizable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        spellcheck: false,
        // 和主窗口同理：拖动/触摸采样靠定时器，被节流就算不出滑动
        backgroundThrottling: false,
      },
    });

    const save = () => {
      if (mirrorWindow && !mirrorWindow.isDestroyed()) {
        saveMirrorBounds(mirrorWindow.getBounds());
      }
    };
    mirrorWindow.on('move', save);
    mirrorWindow.on('resize', save);
    mirrorWindow.on('closed', () => {
      mirrorWindow = null;
      const wasRunning = mirrorWindowRunning;
      mirrorWindowRunning = false;
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mirror:windowClosed', { wasRunning });
      }
    });

    // 同一个渲染入口，用 hash 路由区分（#/float）
    const hash = `/float?serial=${encodeURIComponent(payload.serial || '')}`;
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      await mirrorWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${hash}`);
    } else {
      await mirrorWindow.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
        { hash },
      );
    }
    return { ok: true };
  }

  ipcMain.handle(
    'mirror:openWindow',
    (_, payload: { serial?: string; width?: number; height?: number }) =>
      openMirrorWindow(payload || {}),
  );
  ipcMain.handle('mirror:closeWindow', () => {
    if (mirrorWindow && !mirrorWindow.isDestroyed()) {
      mirrorWindow.close();
    }
    return { ok: true };
  });
  ipcMain.handle(
    'mirror:isOpen',
    () => !!mirrorWindow && !mirrorWindow.isDestroyed(),
  );
  ipcMain.handle('mirror:setOnTop', (_, on: boolean) => {
    if (mirrorWindow && !mirrorWindow.isDestroyed()) {
      // 'floating' 层级：能盖住普通窗口，但不至于盖住系统对话框
      mirrorWindow.setAlwaysOnTop(!!on, 'floating');
    }
    return !!on;
  });
  /** 浮窗里的 scrcpy 日志转发回主窗口的输出面板 */
  ipcMain.handle('mirror:relayLog', (_, text: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('adb:output', { text: String(text || '') });
    }
    return true;
  });

  /** 浮窗自己报告投屏是否在跑（召回时决定要不要自动接着投） */
  ipcMain.handle('mirror:setRunning', (_, running: boolean) => {
    mirrorWindowRunning = !!running;
    return true;
  });

  ipcMain.handle('scrcpy:status', () => ({
    running: isScrcpyRunning(),
    serverFile: scrcpyServerFile,
  }));

  ipcMain.handle(
    'scrcpy:start',
    async (
      _,
      payload: {
        serial?: string;
        maxSize?: number;
        maxFps?: number;
        videoBitRate?: number;
      },
    ) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
      return startScrcpy({
        serial: payload?.serial,
        serverFile: scrcpyServerFile,
        adbFile: info.file,
        maxSize: payload?.maxSize ?? 1024,
        maxFps: payload?.maxFps ?? 30,
        videoBitRate: payload?.videoBitRate ?? 4_000_000,
        onMeta: (meta) => {
          mirrorTarget().send('scrcpy:meta', meta);
        },
        onPacket: (packet) => {
          // 视频包直接转给渲染进程解码（H.264 裸流，WebCodecs 解）
          mirrorTarget().send('scrcpy:packet', packet);
        },
        onLog: (line) => {
          mirrorTarget().send('scrcpy:log', line);
        },
        onError: (message) => {
          mirrorTarget().send('scrcpy:error', message);
        },
        onClose: (reason) => {
          mirrorTarget().send('scrcpy:closed', reason);
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
  /** 读电脑的剪贴板（投屏时把电脑复制的内容输入到手机） */
  ipcMain.handle('clipboard:readText', () => {
    try {
      return { ok: true, text: clipboard.readText() };
    } catch (err) {
      return {
        ok: false,
        text: '',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
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
        stayInApp?: boolean;
        noSwipe?: boolean;
      },
    ) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
      return startMonkey(info.file, {
        ...payload,
        onOutput: (line) => mainWindow.webContents.send('monkey:output', line),
        onEvent: (n) => mainWindow.webContents.send('monkey:event', n),
        onClose: (code) => mainWindow.webContents.send('monkey:closed', code),
        onEscaped: (top) => mainWindow.webContents.send('monkey:escaped', top),
      });
    },
  );

  /* ---------------- 限定区域随机操作（monkey 的替代） ---------------- */

  ipcMain.handle(
    'stress:start',
    async (
      _,
      payload: {
        serial?: string;
        packageName?: string;
        count?: number;
        intervalMs?: number;
        swipeRatio?: number;
      },
    ) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
      return startStress(info.file, {
        ...payload,
        onOutput: (line) => mainWindow.webContents.send('stress:output', line),
        onProgress: (done, total) =>
          mainWindow.webContents.send('stress:progress', { done, total }),
        onEscaped: (top) => mainWindow.webContents.send('stress:escaped', top),
        onClose: (reason) =>
          mainWindow.webContents.send('stress:closed', reason),
      });
    },
  );

  ipcMain.handle('stress:stop', () => ({ ok: stopStress() }));

  ipcMain.handle('stress:running', () => ({ running: isStressRunning() }));

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
      payload: {
        paths: string[];
        dest?: string;
        serial?: string;
        taskId?: string;
      },
    ) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
      return pushFiles(info.file, payload.paths || [], {
        serial: payload.serial,
        taskId: payload.taskId,
        dest: payload.dest || '/sdcard/Download/',
        onOutput: (line) => mainWindow.webContents.send('push:output', line),
        onProgress: (p) => {
          if (payload.taskId) {
            mainWindow.webContents.send('push:progress', {
              taskId: payload.taskId,
              ...p,
            });
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
      await fs.promises.writeFile(
        result.filePath,
        Buffer.from(base64, 'base64'),
      );
      return { canceled: false, filePath: result.filePath };
    },
  );

  // 通用 shell（输出面板的「自定义命令」用）
  ipcMain.handle(
    'adb:shell',
    async (_, payload: { command: string; serial?: string }) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
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

  // 投屏拖动松手时的「兜底翻页」：用手机本地 input swipe 再走一次。
  // 原因：我们注入的触摸是经由 adb 控制通道送到手机的，事件时间戳由 scrcpy 服务端
  // 在收到消息那一刻生成；多条消息落在同一毫秒时 Android 的 VelocityTracker
  // 遇到 dt=0 会直接中断速度计算 → 桌面按「速度为 0」吸附回原页。
  // input swipe 是手机本地生成事件，时间戳天然连续，所以桌面一定认。
  ipcMain.handle(
    'adb:localSwipe',
    async (
      _,
      payload: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        duration: number;
        serial?: string;
      },
    ) => {
      const info = currentAdb();
      if (!info.found)
        return { ok: false, message: info.error || '没找到 adb' };
      const args = [
        'shell',
        'input',
        'swipe',
        String(Math.round(payload.x1)),
        String(Math.round(payload.y1)),
        String(Math.round(payload.x2)),
        String(Math.round(payload.y2)),
        String(Math.round(payload.duration)),
      ];
      if (payload.serial) args.unshift('-s', payload.serial);
      const res = await runAdb(info.file, args, { timeout: 15000 });
      return { ok: res.code === 0, message: (res.stdout + res.stderr).trim() };
    },
  );

  // 当前前台应用的包名（判断是不是桌面，决定要不要兜底翻页）
  ipcMain.handle('adb:foreground', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found) return '';
    const args = ['shell', 'dumpsys', 'window'];
    if (serial) args.unshift('-s', serial);
    const res = await runAdb(info.file, args, { timeout: 15000 });
    const m = res.stdout.match(/mCurrentFocus=Window\{[^}]*?\s([\w.]+)\//);
    return m ? m[1] : '';
  });

  // 手机真实屏幕分辨率（把视频坐标换算成屏幕坐标，兜底滑动要用）
  ipcMain.handle('adb:screenSize', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found) return '';
    const args = ['shell', 'wm', 'size'];
    if (serial) args.unshift('-s', serial);
    const res = await runAdb(info.file, args, { timeout: 15000 });
    const m = res.stdout.match(/(\d+)x(\d+)/);
    return m ? `${m[1]}x${m[2]}` : '';
  });

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
      },
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
