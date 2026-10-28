/**
 * 粘性滚动：用户停在底部时跟随新内容；往上翻后保持位置，直到点“回到底部”。
 * 主窗口和独立阅读窗口共用。
 */
export function createStickyScroll({ container, button, threshold = 24 }) {
  let stick = true;

  function isNearBottom() {
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }

  function updateButton() {
    if (button) button.hidden = isNearBottom();
  }

  function onScroll() {
    stick = isNearBottom();
    updateButton();
  }

  function toBottom() {
    stick = true;
    container.scrollTop = container.scrollHeight;
    updateButton();
  }

  function afterRender(previousScrollTop) {
    if (stick) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = previousScrollTop;
    }
    updateButton();
  }

  function destroy() {
    container.removeEventListener("scroll", onScroll);
    button?.removeEventListener("click", toBottom);
  }

  container.addEventListener("scroll", onScroll);
  button?.addEventListener("click", toBottom);

  return {
    get stick() {
      return stick;
    },
    set stick(value) {
      stick = value;
      updateButton();
    },
    isNearBottom,
    updateButton,
    toBottom,
    afterRender,
    destroy,
  };
}
