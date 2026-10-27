/**
 * 折叠态精灵的“可拖动 + 可点击”拖拽器。
 *
 * 原生 drag region 会吞掉 click，所以这里用主进程轮询光标位置移动窗口；
 * renderer 只负责判断这次 pointer 是点击还是拖动。
 */
export function createWindowDrag({
  getWindow,
  screen,
  pollMs = 16,
  timeoutMs = 60_000,
  onEnd,
} = {}) {
  let timer = null;
  let timeout = null;
  let origin = null;

  function stop() {
    const wasDragging = Boolean(timer);
    if (timer) clearInterval(timer);
    if (timeout) clearTimeout(timeout);
    timer = null;
    timeout = null;
    origin = null;
    if (wasDragging) onEnd?.();
  }

  function start() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    stop();
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    origin = { cursorX: point.x, cursorY: point.y, x: bounds.x, y: bounds.y };
    // 兜底：renderer 丢 pointerup 时不能让窗口一直跟着光标跑。
    timeout = setTimeout(stop, timeoutMs);
    timer = setInterval(() => {
      const current = getWindow();
      if (!origin || !current || current.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      current.setPosition(
        Math.round(origin.x + cursor.x - origin.cursorX),
        Math.round(origin.y + cursor.y - origin.cursorY),
      );
    }, pollMs);
  }

  return { start, stop };
}
