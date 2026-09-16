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
import { getIPAddress } from './utils/node-strings';
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
