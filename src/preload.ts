// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  getIPAddress: () => ipcRenderer.invoke('getIPAddress'),
  getIPAddressList: (): Promise<string[]> =>
    ipcRenderer.invoke('getIPAddressList'),
  getIPAddressInfo: (): Promise<{
    usable: string[];
    excluded: { address: string; name: string }[];
  }> => ipcRenderer.invoke('getIPAddressInfo'),
  onGetLogMsg: (callback: any) =>
    ipcRenderer.on('log:msg', (_event, value) => callback(value)),
  onGetNetworkMsg: (callback: any) =>
    ipcRenderer.on('network:msg', (_event, value) => callback(value)),
  onScanPhone: (callback: any) =>
    ipcRenderer.on('service:msg', (_event, model, clientIP) =>
      callback(model, clientIP),
    ),
  openUrl: (url: string) => ipcRenderer.send('openUrl', url),
  sendRequest: (options: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }) => ipcRenderer.invoke('sendRequest', options),
  checkIsUpdate: () => ipcRenderer.invoke('checkIsUpdate'),
  toggleDevTools: () => ipcRenderer.invoke('toggleDevTools'),
  connectPhone: (clientIP: string, isAgree: boolean) => {
    ipcRenderer.send('connect-phone', clientIP, isAgree);
  },
  pausePhone: (clientIP: string, isPlay: boolean) => {
    ipcRenderer.send('pause-log', clientIP, isPlay);
  },
  startScanPhone: () => ipcRenderer.invoke('startScanPhone'),

  // Electron 32+ 删掉了 File.path，拖拽进来的文件只能这样拿真实路径
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (err) {
      console.warn('getPathForFile 失败', err);
      return '';
    }
  },

  /* ---------------- adb（设备 tab） ---------------- */
  adbInfo: () => ipcRenderer.invoke('adb:info'),
  adbPick: () => ipcRenderer.invoke('adb:pick'),
  adbSetPath: (adbPath: string) => ipcRenderer.invoke('adb:setPath', adbPath),
  adbDevices: () => ipcRenderer.invoke('adb:devices'),
  adbInstall: (
    apkPath: string,
    serial?: string,
    taskId?: string,
    autoOpen?: boolean,
  ) => ipcRenderer.invoke('adb:install', { apkPath, serial, taskId, autoOpen }),
  adbPickApk: () => ipcRenderer.invoke('adb:pickApk'),
  adbPackages: (serial?: string, includeSystem?: boolean) =>
    ipcRenderer.invoke('adb:packages', { serial, includeSystem }),
  /* ---------------- monkey 压测 ---------------- */
  monkeyStart: (options: {
    serial?: string;
    packageName?: string;
    count?: number;
    throttle?: number;
    seed?: number;
    ignoreCrashes?: boolean;
    ignoreTimeouts?: boolean;
  }) => ipcRenderer.invoke('monkey:start', options),
  monkeyStop: () => ipcRenderer.invoke('monkey:stop'),
  onMonkeyOutput: (callback: any) =>
    ipcRenderer.on('monkey:output', (_e, v) => callback(v)),
  onMonkeyEvent: (callback: any) =>
    ipcRenderer.on('monkey:event', (_e, v) => callback(v)),
  onMonkeyClosed: (callback: any) =>
    ipcRenderer.on('monkey:closed', (_e, v) => callback(v)),

  /* ---------------- 快速传文件 ---------------- */
  pushPick: () => ipcRenderer.invoke('push:pick'),
  pushFiles: (paths: string[], dest?: string, serial?: string, taskId?: string) =>
    ipcRenderer.invoke('push:files', { paths, dest, serial, taskId }),
  pushCancel: (taskId: string) => ipcRenderer.invoke('push:cancel', taskId),
  onPushOutput: (callback: any) =>
    ipcRenderer.on('push:output', (_e, v) => callback(v)),
  onPushProgress: (callback: any) =>
    ipcRenderer.on('push:progress', (_e, v) => callback(v)),

  /* ---------------- scrcpy 投屏 / 操控 ---------------- */
  scrcpyStatus: () => ipcRenderer.invoke('scrcpy:status'),
  scrcpyStart: (serial?: string, maxSize?: number, maxFps?: number) =>
    ipcRenderer.invoke('scrcpy:start', { serial, maxSize, maxFps }),
  scrcpyStop: () => ipcRenderer.invoke('scrcpy:stop'),
  scrcpyTouch: (payload: {
    action: 'down' | 'up' | 'move';
    x: number;
    y: number;
    pressure?: number;
  }) => ipcRenderer.invoke('scrcpy:touch', payload),
  scrcpyScroll: (payload: {
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
  }) => ipcRenderer.invoke('scrcpy:scroll', payload),
  scrcpyKey: (keyCode: number, action?: 'down' | 'up' | 'both') =>
    ipcRenderer.invoke('scrcpy:key', { keyCode, action }),
  scrcpyText: (text: string) => ipcRenderer.invoke('scrcpy:text', text),
  scrcpyPower: (on: boolean) => ipcRenderer.invoke('scrcpy:power', on),
  onScrcpyMeta: (callback: any) =>
    ipcRenderer.on('scrcpy:meta', (_e, v) => callback(v)),
  onScrcpyPacket: (callback: any) =>
    ipcRenderer.on('scrcpy:packet', (_e, v) => callback(v)),
  onScrcpyLog: (callback: any) => ipcRenderer.on('scrcpy:log', (_e, v) => callback(v)),
  onScrcpyError: (callback: any) =>
    ipcRenderer.on('scrcpy:error', (_e, v) => callback(v)),
  onScrcpyClosed: (callback: any) =>
    ipcRenderer.on('scrcpy:closed', (_e, v) => callback(v)),

  adbInstallTimes: (serial?: string) => ipcRenderer.invoke('adb:installTimes', serial),
  uiautoFillDebugUrl: (ip: string, serial?: string, buttonText?: string) =>
    ipcRenderer.invoke('uiauto:fillDebugUrl', { ip, serial, buttonText }),
  proxyGet: (serial?: string) => ipcRenderer.invoke('proxy:get', serial),
  proxySet: (value: string, serial?: string) =>
    ipcRenderer.invoke('proxy:set', { value, serial }),
  proxyRestartApp: (packageName: string, serial?: string) =>
    ipcRenderer.invoke('proxy:restartApp', { packageName, serial }),
  proxyCheckPort: (host: string, port: number) =>
    ipcRenderer.invoke('proxy:checkPort', { host, port }),
  adbAppLabels: (
    items: { packageName: string; apkPath: string }[],
    serial?: string,
  ) => ipcRenderer.invoke('adb:appLabels', { items, serial }),
  adbUninstall: (packageName: string, serial?: string, keepData?: boolean) =>
    ipcRenderer.invoke('adb:uninstall', { packageName, serial, keepData }),
  adbCancelInstall: (taskId: string) =>
    ipcRenderer.invoke('adb:cancelInstall', taskId),
  onAdbProgress: (callback: any) =>
    ipcRenderer.on('adb:progress', (_event, value) => callback(value)),
  adbScreencap: (serial?: string) => ipcRenderer.invoke('adb:screencap', serial),
  shotsCount: () => ipcRenderer.invoke('shots:count'),
  shotsList: () => ipcRenderer.invoke('shots:list'),
  shotsLatest: () => ipcRenderer.invoke('shots:latest'),
  shotsRead: (name: string) => ipcRenderer.invoke('shots:read', name),
  shotsSaveAs: (name: string) => ipcRenderer.invoke('shots:saveAs', name),
  shotsDelete: (name: string) => ipcRenderer.invoke('shots:delete', name),
  shotsOpenFolder: () => ipcRenderer.invoke('shots:openFolder'),
  adbWakeup: (serial?: string) => ipcRenderer.invoke('adb:wakeup', serial),
  adbStayAwake: (serial?: string) => ipcRenderer.invoke('adb:stayAwake', serial),
  adbSetStayAwake: (on: boolean, serial?: string) =>
    ipcRenderer.invoke('adb:setStayAwake', { on, serial }),
  adbSaveImage: (dataUrl: string, defaultName: string) =>
    ipcRenderer.invoke('adb:saveImage', { dataUrl, defaultName }),
  adbTcpip: (serial?: string, port?: number) =>
    ipcRenderer.invoke('adb:tcpip', { serial, port }),
  adbConnect: (address: string, port?: number) =>
    ipcRenderer.invoke('adb:connect', { address, port }),
  adbShell: (command: string, serial?: string) =>
    ipcRenderer.invoke('adb:shell', { command, serial }),
  onAdbOutput: (callback: any) =>
    ipcRenderer.on('adb:output', (_event, value) => callback(value)),
});
