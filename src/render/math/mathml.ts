import DOMPurify from "dompurify";
import { t } from "../../i18n";

export type MathmlRenderResult =
  | { ok: true; html: string }
  | { ok: false; error: string };

const MATHML_PROFILE = { USE_PROFILES: { mathMl: true } } as const;

/**
 * 校验并消毒 MathML 片段；非法 XML 返回错误而不是抛异常（FR-05）。
 * 仅在浏览器环境调用（依赖 DOMParser）。
 */
export function renderMathml(source: string): MathmlRenderResult {
  const parsed = new DOMParser().parseFromString(source, "application/xml");
  if (parsed.querySelector("parsererror")) {
    return { ok: false, error: t("MathML 不是合法的 XML 片段") };
  }
  const html = DOMPurify.sanitize(source, MATHML_PROFILE);
  if (!/<math[\s>]/i.test(html)) {
    return { ok: false, error: t("内容不包含 <math> 元素") };
  }
  return { ok: true, html };
}
