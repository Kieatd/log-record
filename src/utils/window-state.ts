import * as fs from 'fs';

export type WindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
};

type DisplayLike = {
  workArea: { x: number; y: number; width: number; height: number };
};

// 兜底的窗口尺寸（没有存档、或存档不可用时使用）
export const DEFAULT_WINDOW_WIDTH = 1360;
export const DEFAULT_WINDOW_HEIGHT = 800;
// 存档明显不合理时忽略（避免出现小到没法用的窗口）
const MIN_WIDTH = 800;
const MIN_HEIGHT = 500;

/** 尺寸是否合理 */
function isSizeValid(bounds: Partial<WindowBounds>): bounds is WindowBounds {
  return (
    typeof bounds.width === 'number' &&
    typeof bounds.height === 'number' &&
    bounds.width >= MIN_WIDTH &&
    bounds.height >= MIN_HEIGHT
  );
}

/**
 * 保存的坐标是否还落在某块屏幕的可见区域内。
 *
 * 必要性：外接显示器拔掉之后，存档里的坐标可能已经在屏幕之外，
 * 直接用会导致窗口"打开但看不见"。
 */
export function isBoundsVisible(
  bounds: Partial<WindowBounds>,
  displays: DisplayLike[],
): boolean {
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
    return false;
  }
  const { x, y } = bounds;
  const width = bounds.width ?? 0;
  const height = bounds.height ?? 0;
  return displays.some(({ workArea }) => {
    return (
      x < workArea.x + workArea.width &&
      x + width > workArea.x &&
      y < workArea.y + workArea.height &&
      y + height > workArea.y
    );
  });
}

/**
 * 把存档整理成可以直接用的窗口参数：
 * - 尺寸不合理 → 用默认尺寸
 * - 坐标不在任何屏幕里 → 只保留尺寸，让系统自己决定位置
 */
export function sanitizeBounds(
  saved: Partial<WindowBounds> | null,
  displays: DisplayLike[],
): WindowBounds {
  if (!saved || !isSizeValid(saved)) {
    return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  }
  const bounds: WindowBounds = {
    width: saved.width,
    height: saved.height,
  };
  if (saved.maximized) {
    bounds.maximized = true;
  }
  if (isBoundsVisible(saved, displays)) {
    bounds.x = saved.x as number;
    bounds.y = saved.y as number;
  }
  return bounds;
}

/** 读取窗口状态；文件不存在或内容损坏都返回 null */
export function loadWindowState(
  filePath: string,
  displays: DisplayLike[],
): WindowBounds {
  try {
    if (!fs.existsSync(filePath)) {
      return sanitizeBounds(null, displays);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return sanitizeBounds(parsed, displays);
  } catch (err) {
    console.warn('读取窗口状态失败，使用默认尺寸', err);
    return sanitizeBounds(null, displays);
  }
}

/** 写入窗口状态（失败不影响主流程） */
export function saveWindowState(
  filePath: string,
  bounds: WindowBounds,
): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(bounds), 'utf-8');
  } catch (err) {
    console.warn('保存窗口状态失败', err);
  }
}
