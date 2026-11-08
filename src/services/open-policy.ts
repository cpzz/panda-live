/** 打开文件的降级阈值。见 doc/design.md §12.1、§14.3。 */
const MB = 1024 * 1024;
const CONFIRM_ABOVE = 10 * MB;
const REJECT_ABOVE = 50 * MB;
const PREFER_SOURCE_ABOVE = 5 * MB;

export interface OpenPolicy {
  /** 拒绝打开。 */
  reject: boolean;
  /** 需要用户确认。 */
  confirm: boolean;
  /** 默认进入源码模式。 */
  preferSource: boolean;
}

export function decideOpenPolicy(size: number): OpenPolicy {
  return {
    reject: size > REJECT_ABOVE,
    confirm: size > CONFIRM_ABOVE,
    preferSource: size > PREFER_SOURCE_ABOVE,
  };
}
