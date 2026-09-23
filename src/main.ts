import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  nativeTheme,
  Menu,
  screen,
} from 'electron';
import fs from 'fs';
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
  connectWifi,
  enableTcpip,
  installApk,
  isScreenAwake,
  listDevices,
  loadCustomAdbPath,
  resolveAdb,
  runAdb,
  saveCustomAdbPath,
  screencap,
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
    async (_, payload: { apkPath: string; serial?: string; taskId?: string }) => {
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
        onOutput: send,
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

  ipcMain.handle('adb:screencap', async (_, serial?: string) => {
    const info = currentAdb();
    if (!info.found) return { ok: false, message: info.error || '没找到 adb' };
    // 息屏时截出来是全黑的，先说清楚，不然用户以为截图坏了
    const awake = await isScreenAwake(info.file, serial);
    const shot = await screencap(info.file, serial);
    if (!shot.ok) return { ok: false, message: shot.message };
    return {
      ok: true,
      message: '截图成功',
      screenAwake: awake,
      dataUrl: `data:image/png;base64,${shot.buffer.toString('base64')}`,
    };
  });

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
