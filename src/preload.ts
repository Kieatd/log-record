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
  adbCancelInstall: (taskId: string) =>
    ipcRenderer.invoke('adb:cancelInstall', taskId),
  onAdbProgress: (callback: any) =>
    ipcRenderer.on('adb:progress', (_event, value) => callback(value)),
  adbScreencap: (serial?: string) => ipcRenderer.invoke('adb:screencap', serial),
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
