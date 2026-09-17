import os from 'os';
import crypto from 'crypto';

type NetIface = { address: string; family: string; internal: boolean };

/**
 * 虚拟 / 隧道类网卡的名字特征。
 *
 * 这些网卡在系统里也是「非 internal 的 IPv4」，但手机连不上，
 * 一旦被选中，界面就会显示一个错的 IP（真实案例：Windows 上
 * OpenVPN 的 TAP 网卡拿到 10.8.0.13，用户照着填，手机根本连不上）。
 *
 * 分两类：
 *   1. 隧道/虚拟化/容器：utun、tun、tap、docker、vmnet、vboxnet、Hyper-V 的 vEthernet…
 *   2. 各家 VPN / 安全客户端：OpenVPN、WireGuard、ZeroTier、Tailscale、
 *      AnyConnect、深信服 EasyConnect、Fortinet、GlobalProtect、Zscaler…
 *      —— 这类客户端装的虚拟网卡名字里通常带厂商名。
 */
const VIRTUAL_IFACE_PATTERN =
  /(utun|tun|tap|ipsec|ppp|bridge|docker|veth|vmnet|vboxnet|awdl|llw|gif|stf|vpn|virtual|hyper-?v|vethernet|wsl|zerotier|tailscale|radmin|hamachi|wireguard|wintun|openvpn|nordlynx|nordvpn|proton|surfshark|expressvpn|mullvad|softether|sangfor|easyconnect|anyconnect|forticlient|fortinet|globalprotect|juniper|netscaler|sstp|l2tp|ikev2|pptp|npcap|loopback|bluetooth|tunnel|teredo|isatap|6to4|zscaler|netskope|checkpoint|sonicwall|watchguard|openconnect|openconnect|neorouter|pulse|array|stonegate|sophos)/i;

/** 看起来像物理网卡的名字：Wi-Fi / WLAN / Ethernet / 以太网 / en0 / eth0 … */
const PHYSICAL_IFACE_PATTERN =
  /(wi-?fi|wlan|wireless|ethernet|en\d+|eth\d+|wlp\d+|eno\d+|以太网|无线|本地连接)/i;

type NetIface = { address: string; family: string; internal: boolean };

/**
 * 判断一个网卡地址是否适合作为「手机上要填的本机 IP」。
 *
 * 排除两类东西（都不是 internal，但手机连不上，一旦被选中就会显示一个错的 IP）：
 * 1. 虚拟/隧道网卡：Clash / Surge 的 utun、Docker / 虚拟机的网卡、各种 VPN 客户端
 * 2. 特殊网段：链路本地、代理 TUN 常用的保留段、运营商级 NAT
 */
export function isUsableLanAddress(
  ifaceName: string,
  address: string,
): boolean {
  if (VIRTUAL_IFACE_PATTERN.test(ifaceName)) {
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

/** 是不是常见的内网段（192.168 / 10 / 172.16-31），用作排序参考 */
function isPrivateLan(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return false;
}

/**
 * 从网卡列表里挑出所有可用地址，按「最可能是局域网 IP」的顺序排。
 *
 * 排序规则（分越高越靠前）：
 *   1. 名字像物理网卡 + 内网段   —— 最典型的情况，直接放第一
 *   2. 名字像物理网卡            —— 名字够可信，网段不常见也认
 *   3. 其它可用地址              —— 名字认不出来（比如 Windows 上的
 *                                  "本地连接 2"），只能靠后站
 * 之所以返回列表而不是单个值：名字判断不可能覆盖所有厂商，
 * 界面上要能把备选地址也列出来，让用户自己试。
 */
export function listLanAddresses(
  interfaces: Record<string, NetIface[] | undefined>,
): string[] {
  const seen = new Set<string>();
  const scored: { address: string; score: number }[] = [];

  for (const [name, list] of Object.entries(interfaces)) {
    for (const alias of list ?? []) {
      if (
        alias.family !== 'IPv4' ||
        alias.internal ||
        !isUsableLanAddress(name, alias.address) ||
        seen.has(alias.address)
      ) {
        continue;
      }
      seen.add(alias.address);
      const physical = PHYSICAL_IFACE_PATTERN.test(name);
      const priv = isPrivateLan(alias.address);
      scored.push({
        address: alias.address,
        score: (physical ? 2 : 0) + (priv ? 1 : 0),
      });
    }
  }

  return scored.sort((x, y) => y.score - x.score).map((item) => item.address);
}

/**
 * 挑出最可能是「局域网 IP」的那个。
 *
 * 之前这里只找 en0/eth0，找不到就取 candidates[0]，
 * 而 os.networkInterfaces() 的顺序由系统决定 —— Windows 上
 * VPN 网卡排在前面时就会选中 10.8.0.13 这种连不上的地址。
 */
export function pickLanAddress(
  interfaces: Record<string, NetIface[] | undefined>,
): string {
  return listLanAddresses(interfaces)[0] ?? '0.0.0.0';
}

/** 被排除掉的地址 + 原因（网卡名），用来排查「是不是把真网卡误杀了」 */
export function listExcludedAddresses(
  interfaces: Record<string, NetIface[] | undefined>,
): { address: string; name: string }[] {
  const result: { address: string; name: string }[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const alias of list ?? []) {
      // internal（127.0.0.1 等）不算「排除」，那是系统自己用的，没必要展示
      if (
        alias.family === 'IPv4' &&
        !alias.internal &&
        !isUsableLanAddress(name, alias.address)
      ) {
        result.push({ address: alias.address, name });
      }
    }
  }
  return result;
}

function getIPAddress(): string {
  return pickLanAddress(
    os.networkInterfaces() as unknown as Record<string, NetIface[]>,
  );
}

function getIPAddressList(): string[] {
  return listLanAddresses(
    os.networkInterfaces() as unknown as Record<string, NetIface[]>,
  );
}

/** 一次拿全：可用地址（第一个是推荐值）+ 被排除的地址 */
function getIPAddressInfo(): {
  usable: string[];
  excluded: { address: string; name: string }[];
} {
  const interfaces = os.networkInterfaces() as unknown as Record<
    string,
    NetIface[]
  >;
  return {
    usable: listLanAddresses(interfaces),
    excluded: listExcludedAddresses(interfaces),
  };
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
export {
  getIPAddress,
  getIPAddressInfo,
  getIPAddressList,
  getSystemIdentifier,
};
