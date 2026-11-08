import { describe, expect, it } from "vitest";
import { EMPTY_PROBLEMS, ProblemStore } from "../../src/services/problem-store";

describe("问题汇总", () => {
  it("同一来源覆盖、不同来源合并", () => {
    const store = new ProblemStore();
    store.setSource("doc-1", "markdown", [{ severity: "warning", message: "解析警告", line: 2 }]);
    store.setSource("doc-1", "extension", [{ severity: "error", message: "扩展错误" }]);

    const problems = store.getState().byDocument["doc-1"] ?? [];
    expect(problems).toHaveLength(2);
    expect(problems.map((item) => item.source)).toEqual(["markdown", "extension"]);
    expect(problems.map((item) => item.id)).toEqual(["markdown:0", "extension:0"]);

    store.setSource("doc-1", "markdown", []);
    const remaining = store.getState().byDocument["doc-1"] ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.source).toBe("extension");
  });

  it("清空后移除文档键，监听器只在状态变化时触发", () => {
    const store = new ProblemStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.setSource("doc-1", "markdown", []);
    expect(notifications).toBe(0);

    store.setSource("doc-1", "markdown", [{ severity: "error", message: "错误" }]);
    expect(notifications).toBe(1);

    store.clearDocument("doc-1");
    expect(store.getState().byDocument["doc-1"]).toBeUndefined();
    expect(notifications).toBe(2);

    store.clearDocument("doc-1");
    expect(notifications).toBe(2);
  });

  it("没有问题时返回稳定的空数组", () => {
    const store = new ProblemStore();
    expect(store.getState().byDocument["missing"] ?? EMPTY_PROBLEMS).toBe(EMPTY_PROBLEMS);
  });
});
