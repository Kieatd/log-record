/**
 * UI 自动化：往 App 的输入框里填字、点按钮。
 *
 * 用来解决「每次电脑 IP 变了，都要在手机上手动改调试地址再重启 App」这件事。
 * 走的是 adb 的 uiautomator，不需要改 App、不需要 root。
 *
 * 刻意不 import electron，方便脱离 Electron 直接用 node 测。
 */
import fs from 'fs';
import { runAdb } from './adb';

export interface UiNode {
  text: string;
  /**
   * content-desc（无障碍标签）。
   * webview 里的按钮，文字往往在 content-desc 里而不是 text ——
   * 调试页那个「设置」按钮就是这样，只读 text 会找不到。
   */
  desc: string;
  cls: string;
  /** [left, top, right, bottom] */
  bounds: [number, number, number, number];
  clickable: boolean;
  focused: boolean;
}

/** 节点面积，用来挑「最具体」的那个 */
function area(n: UiNode): number {
  return (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);
}

/** 解析 uiautomator dump 出来的 XML */
export function parseUiDump(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const get = (name: string) => {
      const mm = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return mm ? mm[1] : '';
    };
    const b = get('bounds').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    nodes.push({
      text: get('text'),
      desc: get('content-desc'),
      cls: get('class'),
      bounds: [
        parseInt(b[1], 10),
        parseInt(b[2], 10),
        parseInt(b[3], 10),
        parseInt(b[4], 10),
      ],
      clickable: get('clickable') === 'true',
      focused: get('focused') === 'true',
    });
  }
  return nodes;
}

export function centerOf(node: UiNode): [number, number] {
  const [l, t, r, b] = node.bounds;
  return [Math.round((l + r) / 2), Math.round((t + b) / 2)];
}

/** 导出当前界面结构 */
export async function dumpUi(
  file: string,
  serial?: string,
): Promise<{ ok: boolean; nodes: UiNode[]; message?: string }> {
  const base = serial ? ['-s', serial] : [];
  const remote = '/data/local/tmp/lr-ui.xml';
  // dump + cat + rm 合成一次 adb shell：
  // 有些手机（比如这台 HONOR）每次 adb shell 要 2~4 秒，拆成三条命令等于白白多花两倍时间。
  // 顺便用 --compressed：只留有意义的节点，老机器上快很多。
  const r = await runAdb(
    file,
    [
      ...base,
      'shell',
      `uiautomator dump --compressed ${remote} >/dev/null 2>&1; cat ${remote}; rm -f ${remote}`,
    ],
    { timeout: 40000 },
  );
  if (!r.stdout.includes('<hierarchy')) {
    return {
      ok: false,
      nodes: [],
      message: (r.stdout + r.stderr).trim() || '导出界面结构失败',
    };
  }
  return { ok: true, nodes: parseUiDump(r.stdout) };
}

/**
 * 在手机上打开一个目录。
 *
 * 分两种情况（这是踩出来的）：
 *
 * ① Android 8（API 26）及以上：一条命令直达
 *    `OPEN_DOCUMENT` + `--eu android.provider.extra.INITIAL_URI <目录的 document URI>`
 *    注意 EXTRA_INITIAL_URI 是 **Uri 类型**，必须用 `--eu`；用 `--es` 传 String，
 *    对方 getParcelableExtra 读出来是 null —— 界面照常打开、只是安静地忽略路径。
 *    另外要先 force-stop，否则文件管理器只把旧任务拉前台，新路径被丢掉。
 *
 * ② Android 7 及以下：**没有**能直接打开指定目录的入口
 *    （EXTRA_INITIAL_URI 是 API 26 才加的；实测这台 HONOR/EMUI 上
 *     DocumentsUI 无论给什么 URI 都停在「最近」、华为文件管理的
 *     FileManager / DeepLinkActivity 也都会忽略路径）。
 *    所以改成「打开文件管理器 → 用 uiautomator 找节点 → 注入点击，逐级进目录」。
 *    实测这条路线能真正进到 /sdcard/Download（标记文件可见）。
 *
 * 文档 URI 的 id 要转义：`primary:Download/Camera` → `primary%3ADownload%2FCamera`
 */

/** 手机 API 版本 */
async function sdkInt(file: string, base: string[]): Promise<number> {
  const r = await runAdb(
    file,
    [...base, 'shell', 'getprop', 'ro.build.version.sdk'],
    {
      timeout: 10000,
    },
  );
  return Number((r.stdout + r.stderr).trim()) || 0;
}

/** 点一下 */
async function tapAt(
  file: string,
  base: string[],
  x: number,
  y: number,
): Promise<void> {
  await runAdb(
    file,
    [
      ...base,
      'shell',
      'input',
      'tap',
      String(Math.round(x)),
      String(Math.round(y)),
    ],
    { timeout: 15000 },
  );
}

/**
 * 按名字点中一层目录。
 * 名字可能不是精确相等（列表里常带“12 项”“2026/09/11”之类的后缀），
 * 所以先找完全相等的，再退回“包含”；同一批里取面积最小的那个（最具体）。
 */
function pickByName(nodes: UiNode[], name: string): UiNode | null {
  const eq = nodes.filter(
    (n) => n.text.trim() === name || n.desc.trim() === name,
  );
  const contains = nodes.filter(
    (n) => n.text.includes(name) || n.desc.includes(name),
  );
  const pool = eq.length ? eq : contains;
  if (!pool.length) return null;
  return pool.slice().sort((a, b) => area(a) - area(b))[0];
}

/** 找不到就往下滑一屏再找（列表可能更长） */
async function tapByName(
  file: string,
  base: string[],
  names: string[],
  serial: string | undefined,
  steps: string[],
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const d = await dumpUi(file, serial);
    if (!d.ok) return false;
    for (const name of names) {
      const node = pickByName(d.nodes, name);
      if (node) {
        const [x, y] = centerOf(node);
        await tapAt(file, base, x, y);
        steps.push(`点「${name}」（${x},${y}）`);
        await new Promise((r) => setTimeout(r, 1100));
        return true;
      }
    }
    // 没找到 → 往下滑一屏
    await runAdb(
      file,
      [...base, 'shell', 'input', 'swipe', '540', '1500', '540', '800', '300'],
      { timeout: 15000 },
    );
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

/** 是否有华为文件管理（只查一次） */
let huaweiFileManager: boolean | null = null;

/** 各家文件管理器里「内部存储」的叫法 */
const STORAGE_ROOT_NAMES = [
  '我的手机',
  '内部存储',
  '内部共享存储空间',
  'Internal storage',
  'Phone',
  'sdcard',
  'SD 卡',
];

/**
 * Android 8 以下：打开文件管理器，再注入点击逐级走进目标目录。
 */
async function navigateToFolder(
  file: string,
  base: string[],
  dir: string,
  serial: string | undefined,
): Promise<{ ok: boolean; message: string; steps: string[] }> {
  const steps: string[] = [];
  // 华为文件管理（EMUI）优先；没有就用系统 DocumentsUI
  if (huaweiFileManager === null) {
    const listed = await runAdb(
      file,
      [...base, 'shell', 'pm', 'list', 'packages', 'com.huawei.hidisk'],
      { timeout: 15000 },
    );
    huaweiFileManager = listed.stdout.includes('com.huawei.hidisk');
  }
  const huawei = huaweiFileManager;

  await runAdb(
    file,
    [...base, 'shell', 'am', 'force-stop', 'com.huawei.hidisk'],
    {
      timeout: 15000,
    },
  );
  const start = huawei
    ? ['am', 'start', '-n', 'com.huawei.hidisk/.filemanager.FileManager']
    : ['am', 'start', '-a', 'android.intent.action.VIEW_DOWNLOADS'];
  await runAdb(file, [...base, 'shell', ...start], { timeout: 20000 });
  steps.push(huawei ? '打开华为文件管理' : '打开系统文件管理');
  await new Promise((r) => setTimeout(r, 1600));

  const segs = dir
    .replace(/^\/(?:sdcard|storage\/emulated\/0)\//, '')
    .split('/')
    .filter(Boolean);

  // 逐级 dump 找节点再点（这台手机没有"直接打开目录"的 API，只能点进去）
  if (!(await tapByName(file, base, STORAGE_ROOT_NAMES, serial, steps))) {
    return {
      ok: false,
      message: '没找到「内部存储」入口，可能界面改了',
      steps,
    };
  }
  for (const seg of segs) {
    if (!(await tapByName(file, base, [seg], serial, steps))) {
      return { ok: false, message: `没找到子目录「${seg}」`, steps };
    }
  }
  return {
    ok: true,
    message: `已在手机上打开 ${dir}（这台手机系统较老，是"点进去"的）`,
    steps,
  };
}

export async function openFolderOnPhone(
  file: string,
  folder: string,
  serial?: string,
): Promise<{ ok: boolean; message: string; steps?: string[] }> {
  const base = serial ? ['-s', serial] : [];
  const dir = folder.endsWith('/') ? folder : `${folder}/`;

  // 路径 → 文档 id
  let docId: string | null = null;
  const internal = dir.match(/^\/(?:sdcard|storage\/emulated\/0)\/(.*)$/);
  if (internal) {
    docId = `primary:${internal[1].replace(/\/+$/, '')}`;
  } else {
    const sd = dir.match(/^\/storage\/([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})\/(.*)$/);
    if (sd) docId = `${sd[1]}:${sd[2].replace(/\/+$/, '')}`;
  }

  const sdk = await sdkInt(file, base);
  if (sdk < 26) {
    // Android 8 以下没有 INITIAL_URI（API 26 才有），只能点进去
    return navigateToFolder(file, base, dir, serial);
  }

  if (!docId) {
    return {
      ok: false,
      message: `暂不支持这个路径：${dir}（只支持内部存储和 SD 卡）`,
    };
  }
  const uri = `content://com.android.externalstorage.documents/document/${encodeURIComponent(docId)}`;
  await runAdb(
    file,
    [...base, 'shell', 'am', 'force-stop', 'com.android.documentsui'],
    {
      timeout: 15000,
    },
  );
  const r = await runAdb(
    file,
    [
      ...base,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.OPEN_DOCUMENT',
      '-c',
      'android.intent.category.OPENABLE',
      '-t',
      'vnd.android.document/directory',
      '--eu',
      'android.provider.extra.INITIAL_URI',
      uri,
    ],
    { timeout: 20000 },
  );
  const out = (r.stdout + r.stderr).trim();
  if (r.code !== 0 || /unable to resolve/i.test(out)) {
    return { ok: false, message: out || '打不开手机上的文件管理器' };
  }
  return {
    ok: true,
    message: `已在手机上打开 ${dir}`,
    steps: [`文档 URI：${uri}`],
  };
}
