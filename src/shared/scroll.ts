/**
 * 把元素滚动到其滚动容器的指定高度比例处（默认约 1/3）。
 *
 * `scrollIntoView({ block: "start" | "center" })` 只能贴顶/居中，
 * 大纲跳转需要把目标行留在视口上方一点、留出阅读上下文，因此手动计算 scrollTop。
 * 从元素向上找到第一个真正可滚动的祖先作为容器；找不到时退回原生 scrollIntoView。
 *
 * 见 doc/design.md §15.1。
 */
export function scrollElementToRatio(element: HTMLElement, ratio = 1 / 3): void {
  let container: HTMLElement | null = element.parentElement;
  while (container) {
    const style = window.getComputedStyle(container);
    const overflowY = style.overflowY;
    const scrollable = overflowY === "auto" || overflowY === "scroll";
    if (scrollable && container.scrollHeight > container.clientHeight) break;
    container = container.parentElement;
  }
  if (!container) {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const rect = container.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  container.scrollTo({
    top: ratioScrollTop(container.scrollTop, target.top - rect.top, rect.height, ratio),
    behavior: "smooth",
  });
}

/**
 * 计算目标滚动位置：让元素落在容器高度的 ratio 处，且不低于顶部。
 * 拆成纯函数便于在无 DOM 环境下验证 1/3 定位。
 */
export function ratioScrollTop(
  scrollTop: number,
  elementOffsetFromTop: number,
  containerHeight: number,
  ratio = 1 / 3,
): number {
  return Math.max(0, scrollTop + elementOffsetFromTop - containerHeight * ratio);
}

/**
 * CodeMirror `scrollIntoView({ y: "start", yMargin })` 的 margin：让目标行
 * 落在视口高度的 ratio 处。与 ratioScrollTop 同一套 1/3 语义，拆出便于测试。
 * CodeMirror 要求 yMargin 小于编辑器高度，故最多取 height - 1。
 */
export function ratioMargin(height: number, ratio = 1 / 3): number {
  return Math.min(Math.max(0, height * ratio), Math.max(0, height - 1));
}
