/**
 * 往手机推文件。
 *
 * 进度用「设备侧目标目录大小」的增量来算：adb push 在管道里不输出百分比
 * （跟安装包那边是同一个坑），所以每 700ms 问一次 du -sk。
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { runAdb } from './adb';

export interface PushProgress {
  /** 已推字节 */
  bytes: number;
  /** 本地总字节 */
  total: number;
  /** 0~100，算不出来就是 0 */
  percent: number;
  /** 当前正在推的第几个 */
  index: number;
  count: number;
  name: string;
}

export interface PushOptions {
  serial?: string;
  taskId?: string;
  dest: string;
  onOutput?: (line: string) => void;
  onProgress?: (p: PushProgress) => void;
}

/** 递归算本地文件/目录的总大小，用来算进度 */
export function localSize(target: string): number {
  let total = 0;
  try {
    const st = fs.statSync(target);
    if (st.isFile()) return st.size;
    for (const name of fs.readdirSync(target)) {
      total += localSize(path.join(target, name));
    }
  } catch {
    /* 拿不到就算了 */
  }
  return total;
}

/** 设备侧目录大小（KB） */
async function remoteKb(
  file: string,
  dest: string,
  serial?: string,
): Promise<number> {
  const args = ['shell', 'du', '-sk', dest];
  if (serial) args.unshift('-s', serial);
  const res = await runAdb(file, args, { timeout: 15000 });
  const m = (res.stdout + res.stderr).match(/^(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

const running = new Map<
  string,
  { child: ReturnType<typeof spawn>; canceled: boolean }
>();

export function cancelPush(taskId: string): boolean {
  const job = running.get(taskId);
  if (!job) return false;
  job.canceled = true;
  try {
    job.child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  return true;
}

/** 推一批文件/目录到手机 */
export async function pushFiles(
  file: string,
  paths: string[],
  options: PushOptions,
): Promise<{ ok: boolean; message: string; canceled?: boolean }> {
  if (!paths.length) return { ok: false, message: '没有要传的文件' };
  const dest = options.dest.endsWith('/') ? options.dest : `${options.dest}/`;
  const missing = paths.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    return { ok: false, message: `这些路径不存在：${missing.join(', ')}` };
  }

  const totals = paths.map((p) => localSize(p));
  const total = totals.reduce((a, b) => a + b, 0);
  const baseKb = await remoteKb(file, dest, options.serial);
  const baseBytes = baseKb * 1024;

  const args = ['push', ...paths, dest];
  if (options.serial) args.unshift('-s', options.serial);

  const name = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

  const result = await new Promise<{ ok: boolean; canceled: boolean; message: string }>(
    (resolve) => {
      const child = spawn(file, args, { windowsHide: true });
      const job = { child, canceled: false };
      if (options.taskId) running.set(options.taskId, job);

      let stderr = '';
      let done = 0;
      let settled = false;
      const started = Date.now();
      let lastBytes = 0;
      let lastChange = Date.now();

      // adb push 的「1 file pushed, ... MB/s」摘要是打在 stderr 上的，
      // 只监听 stdout 的话日志里什么都看不到
      child.stderr?.on('data', (d) => {
        const t = d.toString();
        stderr += t;
        options.onOutput?.(t.trim());
      });
      child.stdout?.on('data', (d) => options.onOutput?.(d.toString().trim()));

      const timer = setInterval(async () => {
        if (settled) return;
        if (Date.now() - lastChange > 120000 || Date.now() - started > 30 * 60 * 1000) {
          settled = true;
          clearInterval(timer);
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve({ ok: false, canceled: false, message: '传输卡住了（2 分钟没进度），已中止' });
          return;
        }
        const kb = await remoteKb(file, dest, options.serial);
        const bytes = Math.max(0, kb * 1024 - baseBytes);
        if (bytes !== lastBytes) {
          lastBytes = bytes;
          lastChange = Date.now();
          // 找到当前推到了第几个
          let acc = 0;
          let index = 0;
          for (let i = 0; i < paths.length; i++) {
            acc += totals[i];
            if (bytes <= acc) {
              index = i;
              break;
            }
            index = i;
          }
          options.onProgress?.({
            bytes,
            total,
            percent: total ? Math.min(99, Math.round((bytes / total) * 100)) : 0,
            index: index + 1,
            count: paths.length,
            name: name(paths[index]),
          });
        }
        done = bytes;
      }, 700);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        resolve({ ok: false, canceled: false, message: err.message || String(err) });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (options.taskId) running.delete(options.taskId);
        if (job.canceled) {
          resolve({ ok: false, canceled: true, message: '已取消传输' });
          return;
        }
        if (code === 0) {
          options.onProgress?.({
            bytes: total,
            total,
            percent: 100,
            index: paths.length,
            count: paths.length,
            name: name(paths[paths.length - 1]),
          });
          resolve({ ok: true, canceled: false, message: `已传到 ${dest}` });
        } else {
          resolve({
            ok: false,
            canceled: false,
            message: stderr.trim().split('\n')[0] || `传输失败（退出码 ${code}）`,
          });
        }
      });
    },
  );

  if (options.taskId) running.delete(options.taskId);
  return result;
}
