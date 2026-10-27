/**
 * 透明窗口默认仍是矩形；CSS border-radius 只裁页面背景，窗口四角依然存在。
 * setShape 把窗口本身裁成圆角矩形，四角才是真正的窗口边界，点击也能穿透。
 */
export function roundedWindowShape(width, height, radius) {
  const r = Math.min(radius, Math.floor(Math.min(width, height) / 2));
  const rects = [];
  const insetAt = (row) => {
    const dy = r - row - 0.5;
    return Math.max(0, Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy))));
  };

  for (let row = 0; row < r; row += 1) {
    const inset = insetAt(row);
    rects.push({ x: inset, y: row, width: width - inset * 2, height: 1 });
  }
  rects.push({ x: 0, y: r, width, height: height - r * 2 });
  for (let row = 0; row < r; row += 1) {
    const inset = insetAt(r - 1 - row);
    rects.push({ x: inset, y: height - r + row, width: width - inset * 2, height: 1 });
  }
  return rects;
}

export function createWindowShape({
  getWindow,
  isCollapsed,
  platform = process.platform,
  radius = 20,
  onError,
} = {}) {
  return function applyWindowShape() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (platform !== "win32" || typeof win.setShape !== "function") return;

    const { width, height } = win.getBounds();
    try {
      win.setShape(
        isCollapsed() ? [{ x: 0, y: 0, width, height }] : roundedWindowShape(width, height, radius),
      );
    } catch (error) {
      onError?.(error);
    }
  };
}
