/**
 * 限定区域内的随机操作（monkey 的替代品）。
 *
 * 为什么不用 monkey：monkey 的触摸坐标是在【整个屏幕】上随机的，
 * 而且它没有任何「限制区域」的参数（help 里翻过了）。
 * 于是它会随机滑到屏幕顶部 → 把通知栏拉下来；滑到底部 → 点到导航栏。
 *
 * 实测：即使把状态栏藏起来（immersive.status），从顶部下滑 5 次里还有 2 次
 * 会把通知栏拉下来；不藏的话 5 次全中。做不到「绝不碰到」。
 *
 * 所以这里自己生成手势：坐标严格限制在 App 的内容区里（避开状态栏和导航栏），
 * 这样每一次点击/滑动都是作用在 App 上的，也不会有通知栏/导航栏的副作用。
 *
 * 代价是速度：每个手势要起一个 input 进程（约 0.35 秒），
 * 大约 2~3 个手势/秒；monkey 是 30+ 个/秒。
 * 但 monkey 绝大多数事件都落不到有意义的位置上，所以按「有效操作数」算，
 * 这个并不亏。
 */
import { runAdb } from './adb';

export interface StressOptions {
  serial?: string;
  /** 目标包名（跑出去就自动停） */
  packageName?: string;
  /** 总共操作多少次 */
  count?: number;
  /** 每次之间隔多久（毫秒） */
  intervalMs?: number;
  /** 滑动占的比例（0~1），其余是点击 */
  swipeRatio?: number;
  /** 顶部避让多少像素（状态栏/刘海） */
  topInset?: number;
  /** 底部避让多少像素（导航栏） */
  bottomInset?: number;
  onOutput?: (line: string) => void;
  onProgress?: (done: number, total: number) => void;
  /** 跑出目标应用（看门狗触发） */
  onEscaped?: (topPackage: string) => void;
  onClose?: (reason: string) => void;
}

interface Job {
  canceled: boolean;
}

let job: Job | null = null;

export function isStressRunning(): boolean {
  return job !== null;
}

export function parseWmSize(out: string): { w: number; h: number } | null {
  // 形如：Physical size: 1080x2220   或   Override size: 1080x2220
  const m = out.match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/);
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 生成一个完全落在 [top, bottom] 区域内的手势命令 */
export function buildGesture(args: {
  width: number;
  height: number;
  topInset: number;
  bottomInset: number;
  swipe: boolean;
}): string {
  const x0 = randInt(Math.round(args.width * 0.06), Math.round(args.width * 0.94));
  const y0 = randInt(args.topInset, args.height - args.bottomInset);
  if (!args.swipe) return `input tap ${x0} ${y0}`;

  // 滑动：长度和方向随机，但【起点和终点都在区域内】，
  // 这样一次滑动绝不会滑到状态栏或导航栏上
  const maxDx = Math.round(args.width * 0.5);
  const maxDy = Math.round(args.height * 0.4);
  const dx = randInt(-maxDx, maxDx);
  const dy = randInt(-maxDy, maxDy);
  const x1 = Math.min(Math.max(x0 + dx, Math.round(args.width * 0.04)), Math.round(args.width * 0.96));
  const y1 = Math.min(
    Math.max(y0 + dy, args.topInset),
    args.height - args.bottomInset,
  );
  const duration = randInt(150, 500);
  return `input swipe ${x0} ${y0} ${x1} ${y1} ${duration}`;
}

/** 当前顶层包名（看门狗用） */
async function topPackage(file: string, serial?: string): Promise<string> {
  const base = serial ? ['-s', serial] : [];
  const res = await runAdb(
    file,
    [...base, 'shell', 'dumpsys activity activities | grep -m1 mResumedActivity'],
    { timeout: 10000 },
  );
  const m = (res.stdout + res.stderr).match(/u0\s+([\w.]+)\//);
  return m ? m[1] : '';
}

/**
 * 开始跑。返回后还在后台继续跑，用 stopStress 停。
 */
export async function startStress(
  file: string,
  options: StressOptions,
): Promise<{ ok: boolean; message: string }> {
  if (job) return { ok: false, message: '已经有一个在跑了' };
  const base = options.serial ? ['-s', options.serial] : [];

  // 屏幕尺寸
  const sizeRes = await runAdb(file, [...base, 'shell', 'wm', 'size'], { timeout: 10000 });
  const size = parseWmSize(sizeRes.stdout + sizeRes.stderr);
  if (!size) return { ok: false, message: '读不到屏幕尺寸' };
  if (!options.packageName) return { ok: false, message: '先选一个要操作的应用' };

  const top = options.topInset ?? 130;
  const bottom = options.bottomInset ?? 200;
  if (size.h - top - bottom < 200) {
    return { ok: false, message: '避让之后可用区域太小了' };
  }

  const current: Job = { canceled: false };
  job = current;

  const total = options.count ?? 200;
  const interval = options.intervalMs ?? 120;
  const swipeRatio = options.swipeRatio ?? 0.35;

  options.onOutput?.(
    `限定区域随机操作：共 ${total} 次，区域 y ${top}~${size.h - bottom}（避开状态栏 ${top}px、导航栏 ${bottom}px），滑动比例 ${Math.round(swipeRatio * 100)}%`,
  );
  // 唤醒屏幕
  await runAdb(file, [...base, 'shell', 'input', 'keyevent', '224'], { timeout: 10000 });

  void (async () => {
    for (let i = 0; i < total; i++) {
      if (current.canceled) {
        options.onOutput?.(`已停止（跑完 ${i} / ${total} 次）`);
        options.onClose?.('canceled');
        if (job === current) job = null;
        return;
      }

      const cmd = buildGesture({
        width: size.w,
        height: size.h,
        topInset: top,
        bottomInset: bottom,
        swipe: Math.random() < swipeRatio,
      });
      const res = await runAdb(file, [...base, 'shell', cmd], { timeout: 15000 });
      const out = (res.stdout + res.stderr).trim();
      if (out && /error|exception/i.test(out)) options.onOutput?.(out);

      options.onProgress?.(i + 1, total);
      if ((i + 1) % 10 === 0) {
        options.onOutput?.(`已操作 ${i + 1} / ${total} 次`);
      }

      // 看门狗：跑出目标应用就停
      if ((i + 1) % 5 === 0) {
        const now = await topPackage(file, options.serial);
        if (now && now !== options.packageName) {
          options.onOutput?.(`⚠️ 跑出目标应用了（当前顶层是 ${now}），已自动停止`);
          options.onEscaped?.(now);
          if (job === current) job = null;
          options.onClose?.('escaped');
          return;
        }
      }

      if (interval > 0) await new Promise((r) => setTimeout(r, interval));
    }
    options.onOutput?.(`跑完了（${total} 次）`);
    if (job === current) job = null;
    options.onClose?.('finished');
  })();

  return { ok: true, message: '已开始' };
}

export function stopStress(): boolean {
  const current = job;
  if (!current) return false;
  current.canceled = true;
  return true;
}
