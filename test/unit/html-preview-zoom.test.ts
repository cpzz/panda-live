import { describe, expect, it } from "vitest";
import {
  buildHtmlPreviewDoc,
  clampHtmlZoom,
  HTML_ZOOM_DEFAULT,
  HTML_ZOOM_MAX,
  HTML_ZOOM_MIN,
  htmlPreviewInjectScript,
  MSG_ZOOM_APPLY,
  MSG_ZOOM_GESTURE,
  MSG_ZOOM_READY,
} from "../../src/render/html-preview";

describe("HTML 预览缩放协议", () => {
  it("注入脚本内联了消息类型与范围常量，且监听键盘/滚轮", () => {
    const script = htmlPreviewInjectScript();
    expect(script).toContain(MSG_ZOOM_GESTURE);
    expect(script).toContain(MSG_ZOOM_READY);
    expect(script).toContain(MSG_ZOOM_APPLY);
    expect(script).toContain(String(HTML_ZOOM_MIN));
    expect(script).toContain(String(HTML_ZOOM_MAX));
    expect(script).toContain('addEventListener("keydown"');
    expect(script).toContain('addEventListener("wheel"');
    expect(script).toContain("document.documentElement.style.zoom");
    // 校验来源，避免被其他 postMessage 伪造手势。
    expect(script).toContain("event.source !== window.parent");
  });

  it("注入脚本插到 </body> 之前，保留原文档内容", () => {
    const source = "<!doctype html><html><body><h1>Hi</h1></body></html>";
    const built = buildHtmlPreviewDoc(source);
    expect(built.indexOf("<script>")).toBeLessThan(built.indexOf("</body>"));
    expect(built).toContain("<h1>Hi</h1>");
    expect(built).toMatch(/<\/body><\/html>$/);
  });

  it("无 </body> 时插到 </html> 之前；纯片段追加到末尾", () => {
    const noBody = "<html><p>only</p></html>";
    const builtNoBody = buildHtmlPreviewDoc(noBody);
    expect(builtNoBody.indexOf("<script>")).toBeLessThan(builtNoBody.indexOf("</html>"));

    const fragment = "<div>frag</div>";
    const builtFragment = buildHtmlPreviewDoc(fragment);
    expect(builtFragment.startsWith(fragment)).toBe(true);
    expect(builtFragment).toContain("<script>");
  });

  it("缩放值被 clamp 到 [30, 500] 且取整", () => {
    expect(clampHtmlZoom(HTML_ZOOM_DEFAULT)).toBe(100);
    expect(clampHtmlZoom(1)).toBe(HTML_ZOOM_MIN);
    expect(clampHtmlZoom(9999)).toBe(HTML_ZOOM_MAX);
    expect(clampHtmlZoom(105.6)).toBe(106);
  });
});
