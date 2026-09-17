import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  nativeTheme,
  Menu,
  screen,
} from 'electron';
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
