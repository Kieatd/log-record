import os from 'os';
import crypto from 'crypto';

type NetIface = { address: string; family: string; internal: boolean };

/**
 * 判断一个网卡地址是否适合作为「手机上要填的本机 IP」。
 *
 * 要排除两类东西（都不是 internal，但手机连不上，一旦被选中就会显示一个错的 IP）：
 * 1. 虚拟/隧道网卡：Clash / Surge 的 utun、Docker / 虚拟机的网卡等
 * 2. 特殊网段：链路本地、代理 TUN 常用的保留段、运营商级 NAT
 */
export function isUsableLanAddress(
  ifaceName: string,
  address: string,
): boolean {
  if (
    /^(utun|tun|tap|ipsec|ppp|bridge|docker|veth|vmnet|vboxnet|awdl|llw|gif|stf)/i.test(
      ifaceName,
    )
  ) {
    return false;
  }
  const [a, b] = address.split('.').map(Number);
  if (address.startsWith('169.254.')) {
    return false; // 169.254.0.0/16 链路本地
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return false; // 198.18.0.0/15 代理工具 TUN 常用保留段
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false; // 100.64.0.0/10 运营商级 NAT
  }
  return true;
}

/**
 * 从网卡列表里挑出最可能是「局域网 IP」的那个。
 * 优先物理网卡（en0 / en1 / eth0 …）——否则网卡遍历顺序一变，
 * 就可能选中 Clash 的 utun（198.18.0.1），界面上就会显示一个错的 IP。
 */
export function pickLanAddress(
  interfaces: Record<string, NetIface[] | undefined>,
): string {
  const candidates: { name: string; address: string }[] = [];

  for (const [name, list] of Object.entries(interfaces)) {
    for (const alias of list ?? []) {
      if (
        alias.family === 'IPv4' &&
        !alias.internal &&
        isUsableLanAddress(name, alias.address)
      ) {
        candidates.push({ name, address: alias.address });
      }
    }
  }

  const physical = candidates.find((item) => /^(en|eth)\d+$/i.test(item.name));
  return (physical ?? candidates[0])?.address ?? '0.0.0.0';
}

function getIPAddress(): string {
  return pickLanAddress(
    os.networkInterfaces() as unknown as Record<string, NetIface[]>,
  );
}

function getSystemIdentifier() {
  // 获取系统信息
  const hostname = os.hostname();
  const username = os.userInfo().username;

  // 组合信息并转换为小写
  const systemInfo = `${hostname}-${username}`.toLowerCase();

  // 使用 md5 处理并截取前 8 位
  // 8位已经有 16^8 = 4,294,967,296 种可能，足够作为本地开发使用
  const hash = crypto
    .createHash('md5')
    .update(systemInfo)
    .digest('hex')
    .slice(0, 8);

  return hash;
}
// isUsableLanAddress / pickLanAddress 已在上面用 export function 导出，这里不要重复列
// （tsc 容忍重复导出，但 esbuild 会直接报错，导致主进程构建失败）
export { getIPAddress, getSystemIdentifier };
