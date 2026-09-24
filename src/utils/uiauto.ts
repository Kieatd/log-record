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
  cls: string;
  /** [left, top, right, bottom] */
  bounds: [number, number, number, number];
  clickable: boolean;
  focused: boolean;
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
  const wanted = nodes.filter(
    (n) => n.text.trim() === text && (n.clickable || /Button/i.test(n.cls)),
  );
  if (!wanted.length) return null;
  if (!input) return wanted[0];
  const inputMid = (input.bounds[1] + input.bounds[3]) / 2;
  // 同一行：垂直中心差在输入框高度以内
  const sameRow = wanted.filter(
    (n) => Math.abs((n.bounds[1] + n.bounds[3]) / 2 - inputMid) < (input.bounds[3] - input.bounds[1]) * 1.5,
  );
  return sameRow[0] || wanted[0];
}

export interface FillResult {
  ok: boolean;
  message: string;
  /** 每一步做了什么，界面和日志里都显示出来 */
  steps: string[];
  /** 填完之后输入框里的实际内容 */
  actual: string;
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
  },
): Promise<FillResult> {
  const steps: string[] = [];
  const base = options.serial ? ['-s', options.serial] : [];
  const buttonText = options.buttonText || '设置';

  const first = await dumpUi(file, options.serial);
  if (!first.ok) {
    return { ok: false, message: first.message || '读不到界面', steps, actual: '' };
  }
  const input = findInput(first.nodes);
  if (!input) {
    return {
      ok: false,
      message: '当前界面上没找到输入框，先把 App 的调试页打开',
      steps,
      actual: '',
    };
  }
  steps.push(`找到输入框，位置 ${centerOf(input).join(',')}`);

  // 点进输入框
  const [ix, iy] = centerOf(input);
  await runAdb(file, [...base, 'shell', 'input', 'tap', String(ix), String(iy)], {
    timeout: 15000,
  });
  steps.push('已点进输入框');

  // 清空：移到末尾再连按退格（没有更干净的办法，input 只能追加）
  await runAdb(
    file,
    [
      ...base,
      'shell',
      'input keyevent 123; for i in $(seq 1 40); do input keyevent 67; done',
    ],
    { timeout: 30000 },
  );
  steps.push('已清空原内容');

  // 填新地址
  await runAdb(
    file,
    [...base, 'shell', 'input', 'text', options.ip],
    { timeout: 15000 },
  );
  steps.push(`已填入 ${options.ip}`);

  // 回读校验：填错了就没必要再点按钮了
  const second = await dumpUi(file, options.serial);
  const after = second.ok ? findInput(second.nodes) : null;
  const actual = after?.text || '';
  if (!actual.includes(options.ip)) {
    return {
      ok: false,
      message: `填进去的内容不对（实际是「${actual}」），没继续点按钮`,
      steps,
      actual,
    };
  }
  steps.push('回读校验通过');

  // 点按钮
  const btn = findButtonNear(second.nodes, after, buttonText);
  if (!btn) {
    return {
      ok: false,
      message: `没找到「${buttonText}」按钮，IP 已经填好了，手动点一下即可`,
      steps,
      actual,
    };
  }
  const [bx, by] = centerOf(btn);
  await runAdb(file, [...base, 'shell', 'input', 'tap', String(bx), String(by)], {
    timeout: 15000,
  });
  steps.push(`已点「${buttonText}」（位置 ${bx},${by}）`);

  return { ok: true, message: '已填入并点了设置', steps, actual };
}
