/**
 * monkey 压力测试。
 *
 * monkey 是 Android 自带的随机事件发生器，往指定应用里乱点乱滑，
 * 用来跑稳定性。这里把它包起来：能看进度、能中途停、能看出崩了没有。
 *
 * 刻意不 import electron，路径由调用方传进来，方便脱离 Electron 直接用 node 测。
 */
import { spawn } from 'child_process';

export interface MonkeyOptions {
  serial?: string;
  /** 要测的包名，不传就是整个系统（危险，一般都要传） */
  packageName?: string;
  /** 事件总数 */
  count?: number;
  /** 每个事件之间的间隔（毫秒） */
  throttle?: number;
  /** 随机种子，用来复现问题 */
  seed?: number;
  ignoreCrashes?: boolean;
  ignoreTimeouts?: boolean;
  /**
   * 只在应用内操作：把 syskeys(HOME/音量)、majornav(BACK/MENU)、appswitch(切应用)
   * 的配比归零。
   *
   * monkey 默认配比里 majornav 占 15%、syskeys 占 2%、appswitch 占 10%，
   * 也就是说有近两成的概率会按 HOME/BACK 或切换应用 —— 跑一会儿必然被踢回桌面。
   * 注意 -p 只限制能访问哪些 Activity，管不住这些按键。
   */
  stayInApp?: boolean;
  onOutput?: (line: string) => void;
  /** 每收到一个事件行回调一次，用来算进度 */
  onEvent?: (events: number) => void;
  onClose?: (code: number | null) => void;
}

interface Job {
  child: ReturnType<typeof spawn>;
  canceled: boolean;
}

let job: Job | null = null;

export function isMonkeyRunning(): boolean {
  return job !== null;
}

export interface MonkeyResult {
  /** 实际执行的事件数 */
  events: number;
  /** 崩掉的应用（// CRASH: 那一行） */
  crashes: string[];
  /** 无响应的应用 */
  anr: string[];
  finished: boolean;
  aborted: boolean;
}

/** 解析 monkey 的输出，把结果和崩溃信息捞出来 */
export function parseMonkeyResult(text: string): MonkeyResult {
  const crashes: string[] = [];
  const anr: string[] = [];
  let events = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^Events injected:\s*(\d+)/);
    if (m) events = Math.max(events, parseInt(m[1], 10));
    const c = line.match(/^\/\/\s*CRASH:\s*(.+)$/);
    if (c) crashes.push(c[1].trim());
    const a = line.match(/^\/\/\s*NOT RESPONDING:\s*(.+)$/);
    if (a) anr.push(a[1].trim());
  }
  const finished = /\/\/\s*Monkey finished/.test(text);
  const aborted = /Monkey aborted|aborted due to error/i.test(text);
  return { events, crashes, anr, finished, aborted };
}

/** 组装 monkey 的参数 */
export function buildMonkeyArgs(options: MonkeyOptions): string[] {
  const args = ['shell', 'monkey'];
  if (options.packageName) args.push('-p', options.packageName);
  args.push('--throttle', String(options.throttle ?? 300));
  if (options.seed !== undefined) args.push('-s', String(options.seed));
  if (options.ignoreCrashes !== false) args.push('--ignore-crashes');
  if (options.ignoreTimeouts !== false) args.push('--ignore-timeouts');
  if (options.stayInApp !== false) {
    // 归零之后 monkey 会把剩余配比重新分配，所以还是能正常压测
    args.push('--pct-syskeys', '0', '--pct-majornav', '0', '--pct-appswitch', '0');
  }
  // -v 会每个事件打一行，用它算进度
  args.push('-v');
  args.push(String(options.count ?? 1000));
  if (options.serial) args.unshift('-s', options.serial);
  return args;
}

/**
 * 开始跑 monkey。
 * 同一时间只允许一个，重复调用会先停掉上一个。
 */
export function startMonkey(
  file: string,
  options: MonkeyOptions,
): { ok: boolean; message: string } {
  if (job) return { ok: false, message: '已经有一个 monkey 在跑了' };
  if (!options.packageName) {
    return { ok: false, message: '先选一个要测的应用' };
  }

  const child = spawn(file, buildMonkeyArgs(options), { windowsHide: true });
  const current: Job = { child, canceled: false };
  job = current;

  let events = 0;
  let buffer = '';
  const handle = (chunk: string) => {
    buffer += chunk;
    // 逐行处理：:Sending 一行 = 一个事件
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      // monkey 不会为每个事件都打日志（30 个事件可能只有 4 行），
      // 所以这里数的是「它记下来的动作数」，界面上如实标成「约 N 个动作」，
      // 不是事件数。真正的事件总数只在结尾的 Events injected 里。
      if (/^:[A-Z]/.test(t) && !/^:Dropped:/.test(t)) {
        events += 1;
        options.onEvent?.(events);
      }
      options.onOutput?.(t);
    }
  };

  child.stdout?.on('data', (d) => handle(d.toString()));
  child.stderr?.on('data', (d) => handle(d.toString()));
  child.on('error', (err) => {
    options.onOutput?.(`启动失败：${err.message || String(err)}`);
  });
  child.on('close', (code) => {
    if (buffer.trim()) options.onOutput?.(buffer.trim());
    if (job === current) job = null;
    options.onClose?.(code);
  });

  return { ok: true, message: 'monkey 已开始' };
}

/** 停掉正在跑的 monkey */
export function stopMonkey(): boolean {
  const current = job;
  if (!current) return false;
  current.canceled = true;
  job = null;
  try {
    current.child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  return true;
}
