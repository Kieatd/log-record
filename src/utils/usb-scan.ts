/**
 * 扫一眼 Mac 的 USB 总线，看有没有「手机插着，但它没把 ADB 通道交出来」。
 *
 * 为什么需要它：安卓手机打开「USB 调试」时，USB 描述符里会多出一个 ADB 接口
 * （class=255 / subclass=66(0x42) / protocol=1）。如果这个接口不在，adb 是
 * **看不见**这台手机（不是"连不上"）—— 真实原因基本都是手机上的「USB 调试」
 * 没开，或者被华为的「允许 HiSuite 通过 HDB 连接设备」抢走了通道。
 * 这种情况 adb devices 永远是空的，光看 app 根本查不出原因。
 *
 * 只支持 macOS：靠 ioreg 读 USB 描述符。
 */
import { execFile } from 'node:child_process';

export interface UsbPhoneInfo {
  /** USB 节点名，例如 BND-AL10@01100000 */
  node: string;
  /** 去掉地址后的名字，例如 BND-AL10 */
  name: string;
  /** 有没有把 ADB 接口暴露给电脑 */
  hasAdb: boolean;
}

/** 像手机/平板的厂商关键字（ioreg 里带厂商名，例如 kUSBVendorString = "HUAWEI"） */
const PHONE_HINT =
  /huawei|honor|xiaomi|redmi|samsung|google|pixel|oppo|vivo|oneplus|realme|meizu|nokia|motorola|sony|android|BND[-_]/i;

/** 华为 HDB（HiSuite 用的调试通道）：subclass 72(0x48) —— 出现它基本就能确定是台华为手机 */
const HDB_HINT = /"bInterfaceSubClass"\s*=\s*72/;
/** ADB 接口：subclass 66(0x42) */
const ADB_IFACE = /"bInterfaceSubClass"\s*=\s*66/;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 10000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err ? '' : String(stdout || ''));
      },
    );
  });
}

export async function scanUsbPhones(): Promise<{
  ok: boolean;
  /** 这个平台支不支持这项检测（目前只有 macOS 支持） */
  supported: boolean;
  phones: UsbPhoneInfo[];
}> {
  if (process.platform !== 'darwin') {
    return { ok: true, supported: false, phones: [] };
  }

  const tree = await run('ioreg', ['-p', 'IOUSB', '-w0']);
  const nodes = Array.from(tree.matchAll(/\+\-o (\S+@[0-9a-fA-F]+)/g)).map(
    (m) => m[1],
  );

  const phones: UsbPhoneInfo[] = [];
  // 最多看 6 个节点：ioreg 每次要几百毫秒，正常失败路径下也就 1～2 个
  for (const node of nodes.slice(0, 6)) {
    if (/^Apple/i.test(node)) continue; // 内置总线 / 内建设备
    const sub = await run('ioreg', [
      '-p',
      'IOService',
      '-w0',
      '-l',
      '-r',
      '-n',
      node,
    ]);
    if (!sub) continue;
    const looksPhone =
      PHONE_HINT.test(node) || PHONE_HINT.test(sub) || HDB_HINT.test(sub);
    if (!looksPhone) continue;
    phones.push({
      node,
      name: node.replace(/@[0-9a-fA-F]+$/, ''),
      hasAdb: ADB_IFACE.test(sub),
    });
  }

  return { ok: true, supported: true, phones };
}
