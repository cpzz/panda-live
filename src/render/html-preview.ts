/**
 * HTML 预览的 iframe 缩放协议。
 *
 * 预览 iframe 是 `sandbox="allow-scripts"` 的 opaque origin：脚本能运行，但父窗口
 * 无法通过 contentDocument 直接改它的样式。因此缩放分两侧协作：
 *  - 父窗口（HtmlPreviewPane）持有缩放百分比这一唯一数据源，监听快捷键/滚轮并计算新值；
 *  - iframe 内注入的这段脚本监听自身文档的事件转发给父窗口，并接收父窗口下发的
 *    绝对缩放值，作用到 `document.documentElement.style.zoom`。
 * 用 postMessage + event.source 校验通信，不依赖 allow-same-origin。见 doc/design.md §3.3。
 */

/** 消息前缀，避免与图表沙箱池等其他 postMessage 混淆。 */
const MSG_PREFIX = "panda:html-preview:";
/** 子 → 父：iframe 内的缩放手势（in/out/reset），父据此按步进计算。 */
export const MSG_ZOOM_GESTURE = `${MSG_PREFIX}gesture`;
/** 子 → 父：iframe 脚本已就绪，可接收当前缩放值。 */
export const MSG_ZOOM_READY = `${MSG_PREFIX}ready`;
/** 父 → 子：应用绝对缩放百分比。 */
export const MSG_ZOOM_APPLY = `${MSG_PREFIX}apply`;

export const HTML_ZOOM_MIN = 30;
export const HTML_ZOOM_MAX = 500;
export const HTML_ZOOM_STEP = 10;
export const HTML_ZOOM_DEFAULT = 100;

export function clampHtmlZoom(value: number): number {
  return Math.min(HTML_ZOOM_MAX, Math.max(HTML_ZOOM_MIN, Math.round(value)));
}

/**
 * 生成注入 iframe 文档的缩放脚本（不含 <script> 标签）。
 * 常量内联为字面量，使脚本在 opaque origin 中独立可用。
 */
export function htmlPreviewInjectScript(): string {
  return `
(function () {
  "use strict";
  var GESTURE = ${JSON.stringify(MSG_ZOOM_GESTURE)};
  var READY = ${JSON.stringify(MSG_ZOOM_READY)};
  var APPLY = ${JSON.stringify(MSG_ZOOM_APPLY)};
  var MIN = ${HTML_ZOOM_MIN};
  var MAX = ${HTML_ZOOM_MAX};

  function send(action) {
    try { window.parent.postMessage({ type: GESTURE, action: action }, "*"); } catch (e) {}
  }
  function apply(zoom) {
    var value = Math.min(MAX, Math.max(MIN, Number(zoom) || 100));
    document.documentElement.style.zoom = String(value / 100);
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== APPLY) return;
    apply(data.zoom);
  });

  window.addEventListener("keydown", function (event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    var key = event.key;
    if (key === "=" || key === "+") { event.preventDefault(); send("in"); }
    else if (key === "-" || key === "_") { event.preventDefault(); send("out"); }
    else if (key === "0") { event.preventDefault(); send("reset"); }
  });

  window.addEventListener("wheel", function (event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    send(event.deltaY < 0 ? "in" : "out");
  }, { passive: false });

  try { window.parent.postMessage({ type: READY }, "*"); } catch (e) {}
})();
`.trim();
}

/**
 * 把缩放脚本注入用户 HTML 文档，作为预览 iframe 的 srcDoc。
 * 优先插到 </body> 前，其次 </html> 前，都没有则追加到末尾（兼容 HTML 片段）。
 */
export function buildHtmlPreviewDoc(source: string): string {
  const script = `<script>${htmlPreviewInjectScript()}</script>`;
  const lowered = source.toLowerCase();
  const bodyIdx = lowered.lastIndexOf("</body");
  if (bodyIdx >= 0) return source.slice(0, bodyIdx) + script + source.slice(bodyIdx);
  const htmlIdx = lowered.lastIndexOf("</html");
  if (htmlIdx >= 0) return source.slice(0, htmlIdx) + script + source.slice(htmlIdx);
  return source + script;
}
