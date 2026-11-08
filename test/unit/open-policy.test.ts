import { describe, expect, it } from "vitest";
import { decideOpenPolicy } from "../../src/services/open-policy";

const MB = 1024 * 1024;

describe("打开文件降级策略", () => {
  it("小文件不触发任何降级", () => {
    const policy = decideOpenPolicy(1 * MB);
    expect(policy).toEqual({ reject: false, confirm: false, preferSource: false });
  });

  it("超过 5 MB 默认源码模式", () => {
    const policy = decideOpenPolicy(6 * MB);
    expect(policy.preferSource).toBe(true);
    expect(policy.confirm).toBe(false);
    expect(policy.reject).toBe(false);
  });

  it("超过 10 MB 需要确认", () => {
    expect(decideOpenPolicy(12 * MB).confirm).toBe(true);
  });

  it("超过 50 MB 拒绝打开", () => {
    const policy = decideOpenPolicy(51 * MB);
    expect(policy.reject).toBe(true);
  });
});
