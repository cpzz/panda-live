import { describe, expect, it } from "vitest";
import { validateManifest } from "../../electron/extensions/manifest";
import sample from "../../extensions/examples/asciidoc/extension.json";

const VERSION = "0.1.0";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(sample as Record<string, unknown>),
    ...overrides,
  };
}

describe("扩展清单校验", () => {
  it("示例扩展清单合法", () => {
    const result = validateManifest(sample, VERSION);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.id).toBe("panda.sample-asciidoc");
    expect(result.manifest?.contributes.formats[0]?.capabilities.preview).toBe("inline");
  });

  it("引擎版本不匹配时拒绝", () => {
    const result = validateManifest(base({ engines: { panda: "^2.0.0" } }), VERSION);
    expect(result.manifest).toBeNull();
    expect(result.errors.join(";")).toContain("不匹配应用版本");
  });

  it("未知权限被拒绝", () => {
    const result = validateManifest(base({ permissions: ["network"] }), VERSION);
    expect(result.errors.join(";")).toContain("未知权限");
  });

  it("格式引用未声明语言时失败", () => {
    const manifests = base();
    const contributes = { ...(manifests["contributes"] as Record<string, unknown>) };
    contributes["languages"] = [];
    const result = validateManifest({ ...manifests, contributes }, VERSION);
    expect(result.errors.join(";")).toContain("未声明的语言");
  });

  it("入口路径穿越被拒绝", () => {
    const result = validateManifest(base({ main: "../escape.js" }), VERSION);
    expect(result.errors.join(";")).toContain("main");
  });

  it("未知激活事件被拒绝", () => {
    const result = validateManifest(base({ activationEvents: ["onTimer:1"] }), VERSION);
    expect(result.errors.join(";")).toContain("未知激活事件");
  });

  it("声明格式但缺少 main 时失败", () => {
    const result = validateManifest(base({ main: undefined }), VERSION);
    expect(result.errors.join(";")).toContain("必须提供 main");
  });
});
