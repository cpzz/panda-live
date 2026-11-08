export const ERROR_CODES = [
  "E_PAYLOAD_INVALID",
  "E_PATH_OUTSIDE_ROOT",
  "E_FILE_NOT_FOUND",
  "E_FILE_CHANGED",
  "E_FILE_TOO_LARGE",
  "E_PERMISSION_DENIED",
  "E_ENCODING_UNSUPPORTED",
  "E_PARSE_FAILED",
  "E_RENDER_TIMEOUT",
  "E_ENGINE_MISSING",
  "E_COMPILE_FAILED",
  "E_EXPORT_FAILED",
  "E_EXTENSION_INVALID",
  "E_EXTENSION_INCOMPATIBLE",
  "E_EXTENSION_ACTIVATION_FAILED",
  "E_EXTENSION_PERMISSION_DENIED",
  "E_EXTENSION_CRASHED",
  "E_CANCELLED",
  "E_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PandaErrorPayload {
  code: ErrorCode;
  message: string;
}

export class PandaError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PandaError";
    this.code = code;
  }
}

export function isPandaError(error: unknown): error is PandaError {
  return error instanceof PandaError;
}

/**
 * contextBridge 会把抛出的错误序列化为普通 Error（自定义属性丢失），
 * 因此跨桥错误以 `E_XXX: message` 形式编码，这里统一还原错误码。
 */
export function getErrorCode(error: unknown): ErrorCode | null {
  if (isPandaError(error)) return error.code;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = message.match(/\bE_[A-Z_]+\b/);
  return match && (ERROR_CODES as readonly string[]).includes(match[0])
    ? (match[0] as ErrorCode)
    : null;
}

export function describeError(error: unknown): string {
  if (isPandaError(error)) return error.message;
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return raw.replace(/^E_[A-Z_]+:\s*/, "");
}

export function toErrorPayload(error: unknown): PandaErrorPayload {
  if (isPandaError(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "E_INTERNAL", message: error.message };
  }
  return { code: "E_INTERNAL", message: String(error) };
}
