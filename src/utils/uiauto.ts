/**
 * UI 自动化：往 App 的输入框里填字、点按钮。
 *
 * 用来解决「每次电脑 IP 变了，都要在手机上手动改调试地址再重启 App」这件事。
 * 走的是 adb 的 uiautomator，不需要改 App、不需要 root。
 *
 * 刻意不 import electron，方便脱离 Electron 直接用 node 测。
 */
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
  const dump = await runAdb(
    file,
    [...base, 'shell', 'uiautomator', 'dump', remote],
    { timeout: 30000 },
  );
  if (!/dumped to/i.test(dump.stdout + dump.stderr)) {
    return {
      ok: false,
      nodes: [],
      message: (dump.stdout + dump.stderr).trim() || '导出界面结构失败',
    };
  }
  const cat = await runAdb(file, [...base, 'exec-out', 'cat', remote], {
    timeout: 20000,
  });
  await runAdb(file, [...base, 'shell', 'rm', '-f', remote], { timeout: 10000 });
  if (!cat.stdout.includes('<hierarchy')) {
    return { ok: false, nodes: [], message: '读出来的界面结构不对' };
  }
  return { ok: true, nodes: parseUiDump(cat.stdout) };
}

/** 找一个输入框（优先当前已聚焦的） */
export function findInput(nodes: UiNode[]): UiNode | null {
  const edits = nodes.filter((n) => /EditText/i.test(n.cls));
  if (!edits.length) return null;
  return edits.find((n) => n.focused) || edits[0];
}

/**
 * 找一个按钮。
 * 优先「和输入框同一行、且可点击」的那个 —— 调试页里「设置」按钮就在输入框右边，
 * 用行对齐来找比纯按文字找稳。
 */
export function findButtonNear(
  nodes: UiNode[],
  input: UiNode | null,
  text: string,
): UiNode | null {
  // text 和 content-desc 都算：webview 里的按钮文字常在 content-desc
  const wanted = nodes.filter(
    (n) => n.text.trim() === text || n.desc.trim() === text,
  );
  if (!wanted.length) return null;

  // 同一行的优先（按钮一般就在输入框右边）
  let candidates = wanted;
  if (input) {
    const inputMid = (input.bounds[1] + input.bounds[3]) / 2;
    const sameRow = wanted.filter(
      (n) =>
        Math.abs((n.bounds[1] + n.bounds[3]) / 2 - inputMid) <
        (input.bounds[3] - input.bounds[1]) * 1.5,
    );
    if (sameRow.length) candidates = sameRow;
  }

  // 取最小的那个：webview 里同一行上，可点击的容器会包住整行
  //（bounds 覆盖整个输入框），点它的中心会点到输入框。
  // 真正按钮的文字节点小得多，位置也对。
  return candidates.slice().sort((a, b) => area(a) - area(b))[0];
}

export interface FillResult {
  ok: boolean;
  message: string;
  /** 每一步做了什么，界面和日志里都显示出来 */
  steps: string[];
  /** 填完之后输入框里的实际内容 */
  actual: string;
  /** 耗时（毫秒），界面上显示出来 */
  ms: number;
  /** 这次走的是快路径（用了缓存坐标，没 dump） */
  cached: boolean;
}

/**
 * 坐标缓存：同一个界面反复填的时候，没必要每次都 dump（每次 1~2 秒）。
 * key 用 序列号:包名:屏幕尺寸，屏幕尺寸变了（转屏/换设备）就重新 dump。
 */
const coordCache = new Map<
  string,
  { input: [number, number]; button: [number, number] }
>();

/** 每个设备上次成功填过的 IP，用来跳过重复填写 */
const lastFilledIp = new Map<string, string>();

export function clearCoordCache(): void {
  coordCache.clear();
}

/** 数字和点号的键码，用来把 IPv4 直接按键打进去 */
const DIGIT_KEYCODE: Record<string, number> = {
  '0': 7, '1': 8, '2': 9, '3': 10, '4': 11,
  '5': 12, '6': 13, '7': 14, '8': 15, '9': 16,
  '.': 56,
};

/** IPv4 地址就返回它的键码序列，否则 null（用 input text 兜底） */
export function ipToKeycodes(ip: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())) return null;
  const codes: number[] = [];
  for (const ch of ip.trim()) {
    const k = DIGIT_KEYCODE[ch];
    if (k === undefined) return null;
    codes.push(k);
  }
  return codes;
}

/**
 * 一次 shell 里把点击/清空/输入做完。
 *
 * 关键点：每启动一个 input 进程在 Android 上要约 0.4 秒，
 * 所以能合并就合并 —— 退格和输入合成同一条 input keyevent
 * （keyevent 支持一次传多个键码；40 次退格分开写要 16 秒，合并后 0.7 秒）。
 */
function buildFillCommand(
  input: [number, number],
  button: [number, number] | null,
  ip: string,
  /** 要按几次退格 */
  backspaces: number,
): string {
  const keycodes: number[] = [
    123, // 移到行尾
    ...Array(backspaces).fill(67), // 退格
  ];
  const digitCodes = ipToKeycodes(ip);
  if (digitCodes) {
    // IPv4：直接用键码打，省掉一次 input text
    keycodes.push(...digitCodes);
  }
  const parts = [
    `input tap ${input[0]} ${input[1]}`,
    `input keyevent ${keycodes.join(' ')}`,
  ];
  if (!digitCodes) parts.push(`input text ${ip}`);
  if (button) parts.push(`input tap ${button[0]} ${button[1]}`);
  return parts.join('; ');
}

/**
 * 把 ip 填进调试页的输入框并点「设置」。
 * 前置条件：手机上那个调试页已经打开、且屏幕是亮的。
 */
export async function fillDebugUrl(
  file: string,
  options: {
    ip: string;
    serial?: string;
    /** 按钮上的文字，默认「设置」 */
    buttonText?: string;
    /** 屏幕尺寸，参与缓存 key */
    screenKey?: string;
    /** 强制重填（哪怕 IP 没变） */
    force?: boolean;
  },
): Promise<FillResult> {
  const started = Date.now();
  const steps: string[] = [];
  const base = options.serial ? ['-s', options.serial] : [];
  const buttonText = options.buttonText || '设置';
  const cacheKey = `${options.serial || ''}:${options.screenKey || ''}:${buttonText}`;
  const cached = coordCache.get(cacheKey);
  const lastIp = lastFilledIp.get(options.serial || '');

  // 最常见的情况：IP 根本没变（网络没换）。那就没必要再点一遍输入框、清空、重填，
  // 直接跳过 —— 只有电脑 IP 变了才真的需要填。
  if (lastIp === options.ip.trim() && !options.force) {
    steps.push(`上次已经填过 ${options.ip}，跳过填写`);
    return {
      ok: true,
      message: '地址没变，已跳过填写',
      steps,
      actual: options.ip,
      ms: Date.now() - started,
      cached: true,
    };
  }
  const done = (r: Omit<FillResult, 'ms' | 'cached'>): FillResult => ({
    ...r,
    ms: Date.now() - started,
    cached: !!cached,
  });

  // ---- 快路径：坐标有缓存，一条 shell 命令全做完 ----
  if (cached) {
    await runAdb(
      file,
      [
        ...base,
        'shell',
        `input keyevent 224; ${buildFillCommand(cached.input, cached.button, options.ip, 24)}`,
      ],
      { timeout: 30000 },
    );
    steps.push('用缓存坐标直接完成（点击/清空/输入/点按钮）');
    lastFilledIp.set(options.serial || '', options.ip.trim());
    return done({ ok: true, message: '已填入并点了设置（快）', steps, actual: options.ip });
  }

  // ---- 慢路径（第一次）：先唤醒屏幕，再 dump 找位置 ----
  // 息屏时 uiautomator 拿到的是空结构，会误报「没找到输入框」，
  // 所以先点亮，并且把屏幕状态单独报出来（息屏/锁屏是最常见的失败原因）
  await runAdb(file, [...base, 'shell', 'input', 'keyevent', '224'], { timeout: 10000 });
  const wake = await runAdb(file, [...base, 'shell', 'dumpsys', 'power'], { timeout: 15000 });
  const awake = /mWakefulness=Awake/.test(wake.stdout + wake.stderr);
  if (!awake) {
    return done({
      ok: false,
      message: '手机屏幕是黑的（息屏或锁屏），先按电源键点亮并解锁，再点这里',
      steps,
      actual: '',
    });
  }

  const first = await dumpUi(file, options.serial);
  if (!first.ok) {
    return done({ ok: false, message: first.message || '读不到界面', steps, actual: '' });
  }
  const input = findInput(first.nodes);
  if (!input) {
    return done({
      ok: false,
      message: '当前界面上没找到输入框 —— 确认手机上打开的是 App 的调试页（填调试Url那个页面）',
      steps,
      actual: '',
    });
  }
  const btn = findButtonNear(first.nodes, input, buttonText);
  if (!btn) {
    return done({
      ok: false,
      message: `当前界面上没找到「${buttonText}」按钮，先把 App 的调试页打开`,
      steps,
      actual: '',
    });
  }
  const inputCenter = centerOf(input);
  const btnCenter = centerOf(btn);
  steps.push(`找到输入框 ${inputCenter.join(',')}、按钮「${buttonText}」${btnCenter.join(',')}`);

  // 退格次数按当前内容长度来，不用固定 40 次
  const backspaces = Math.max(16, (input.text || '').length + 6);

  // 先只做「点击 + 清空 + 输入」，然后回读校验，通过了再点按钮
  await runAdb(
    file,
    [...base, 'shell', buildFillCommand(inputCenter, null, options.ip, backspaces)],
    { timeout: 30000 },
  );
  steps.push(`已点击输入框、清空（${backspaces} 次退格）、填入 ${options.ip}`);

  const second = await dumpUi(file, options.serial);
  const after = second.ok ? findInput(second.nodes) : null;
  const actual = after?.text || '';
  if (!actual.includes(options.ip)) {
    return done({
      ok: false,
      message: `填进去的内容不对（实际是「${actual}」），没继续点按钮`,
      steps,
      actual,
    });
  }
  steps.push('回读校验通过');

  // 点按钮用「填完之后」这次 dump 的坐标，不要用填之前那次 ——
  // 界面一旦有位移（键盘弹出、页面重排），旧坐标就点到别的地方去了。
  // 填完之后本来就要 dump 一次做校验，顺便从这次里取按钮位置。
  const btnAfter = findButtonNear(second.nodes, after, buttonText) || btn;
  const tapCenter = centerOf(btnAfter);
  if (tapCenter[0] !== btnCenter[0] || tapCenter[1] !== btnCenter[1]) {
    steps.push(`注意：按钮位置从 ${btnCenter.join(',')} 变到 ${tapCenter.join(',')}，按新的点`);
  }
  await runAdb(
    file,
    [...base, 'shell', 'input', 'tap', String(tapCenter[0]), String(tapCenter[1])],
    { timeout: 15000 },
  );
  steps.push(`已点「${buttonText}」（位置 ${tapCenter.join(',')}）`);
  coordCache.set(cacheKey, { input: inputCenter, button: tapCenter });
  lastFilledIp.set(options.serial || '', options.ip.trim());
  steps.push('坐标已缓存，下次会快很多');

  return done({ ok: true, message: '已填入并点了设置', steps, actual });
}
