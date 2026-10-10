/**
 * 把电脑上的文字「粘贴」进手机当前聚焦的输入框。
 *
 * 为什么不用 scrcpy 的 injectText：它靠 KeyCharacterMap 把字符映射成按键事件，
 * 中文/表情没有对应按键 → 注不进去（实测手机里什么都不出现，还可能让手机卡一下）。
 * scrcpy 3.3 的控制协议里也不再有「设置设备剪贴板」这个消息。
 *
 * 所以走 uiautomator：
 *   1. 用一个小 jar（resources/lr-textsetter.jar）把文字写进**手机剪贴板**
 *   2. 再给手机发一个「粘贴」按键（KEYCODE_PASTE）
 * 这样任何输入框都能粘贴，中文也没问题，而且是在光标处插入（就是粘贴该有的语义）。
 *
 * 文字用 base64 传（避免命令行转义问题），结果写文件再读回来（不依赖 stdout）。
 */
import { runAdb } from './adb';

const JAR_REMOTE = '/data/local/tmp/lr-textsetter.jar';
const B64_REMOTE = '/data/local/tmp/lr-text.b64';
const RESULT_REMOTE = '/sdcard/lr-result.txt';

export async function pasteTextToPhone(
  adbFile: string,
  jarPath: string,
  text: string,
  serial?: string,
): Promise<{ ok: boolean; message: string }> {
  const base = serial ? ['-s', serial] : [];
  const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  if (!b64) return { ok: false, message: '没有要粘贴的内容' };

  // ① 推脚本（1.6KB，很快）
  const push = await runAdb(adbFile, [...base, 'push', jarPath, JAR_REMOTE], {
    timeout: 15000,
  });
  if (push.code !== 0) {
    return {
      ok: false,
      message: `推粘贴脚本失败：${(push.stderr || push.stdout || '').trim()}`,
    };
  }

  // ② 写 base64 + 清掉上次的结果（纯 ASCII，不用怕转义）
  await runAdb(
    adbFile,
    [...base, 'shell', `echo ${b64} > ${B64_REMOTE}; rm -f ${RESULT_REMOTE}`],
    { timeout: 10000 },
  );

  // ③ 跑（uiautomator 启动要 1～2 秒）
  const run = await runAdb(
    adbFile,
    [
      ...base,
      'shell',
      `uiautomator runtest ${JAR_REMOTE} -c com.logrecord.paste.TextPaster`,
    ],
    { timeout: 30000 },
  );

  // ④ 读结果
  const res = await runAdb(
    adbFile,
    [...base, 'shell', `cat ${RESULT_REMOTE} 2>/dev/null`],
    { timeout: 10000 },
  );
  const out = String(res.stdout || '').trim();
  if (out.startsWith('OK_NOT_FIELD')) {
    // 粘贴键发出去了，但当时聚焦的看起来不是输入框 —— 大概率没粘上
    return {
      ok: true,
      message: '已发送粘贴；如果手机上没出现，先在手机上点一下要输入的框再试',
    };
  }
  if (out.startsWith('OK')) return { ok: true, message: '已粘贴到手机' };
  if (out === 'NO_TEXT') return { ok: false, message: '没有要粘贴的内容' };
  if (out.startsWith('NO_')) {
    return { ok: false, message: '这台手机不支持这种粘贴方式' };
  }
  const tail = (run.stderr || run.stdout || '').trim().split('\n').pop() || '';
  return {
    ok: false,
    message: tail
      ? `粘贴失败：${tail}`
      : '粘贴失败：先在手机上点一下要输入的框，再试一次',
  };
}
