import { utilityProcess, type UtilityProcess } from "electron";
import { t } from "../../src/i18n";

const ACTIVATION_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 10_000;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActivationWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ActivateRequest {
  extensionId: string;
  extensionPath: string;
  mainPath: string;
  settings: Record<string, unknown>;
}

/**
 * 扩展宿主进程管理：Utility Process + RPC + 超时与崩溃清理。
 * 见 doc/design.md §7.6.3–§7.6.5。
 */
export class ExtensionHost {
  private child: UtilityProcess | null = null;
  private readonly pending = new Map<number, PendingCall>();
  private nextRequestId = 1;
  private activation: ActivationWaiter | null = null;
  private activeExtensionId: string | null = null;
  private ready: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly runnerPath: string,
    private readonly onLog: (message: string) => void = () => undefined,
  ) {}

  get currentExtension(): string | null {
    return this.activeExtensionId;
  }

  async activate(request: ActivateRequest): Promise<void> {
    const child = await this.ensureChild();
    if (this.activation) {
      this.activation.reject(
        new Error(`E_EXTENSION_ACTIVATION_FAILED: ${t("新的激活请求已开始")}`),
      );
      this.activation = null;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activation = null;
        this.dispose();
        reject(new Error(`E_EXTENSION_ACTIVATION_FAILED: ${t("激活超时（5 s）")}`));
      }, ACTIVATION_TIMEOUT_MS);
      this.activation = { resolve, reject, timer };
      child.postMessage({
        type: "activate",
        extensionId: request.extensionId,
        extensionPath: request.extensionPath,
        mainPath: request.mainPath,
        settings: request.settings,
      });
    });
    this.activeExtensionId = request.extensionId;
  }

  async call(method: "parse" | "serialize" | "preview" | "command", payload: unknown, extensionId: string): Promise<unknown> {
    if (!this.child || this.activeExtensionId !== extensionId) {
      throw new Error(`E_EXTENSION_ACTIVATION_FAILED: ${t("扩展未激活")}`);
    }
    const requestId = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`E_EXTENSION_ACTIVATION_FAILED: ${t("调用超时（10 s）")}`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child?.postMessage({ type: "call", requestId, method, payload });
    });
  }

  dispose(): void {
    if (this.ready) {
      clearTimeout(this.ready.timer);
      this.ready.reject(new Error(`E_EXTENSION_CRASHED: ${t("扩展宿主已停止")}`));
      this.ready = null;
    }
    if (this.activation) {
      clearTimeout(this.activation.timer);
      this.activation.reject(new Error(`E_EXTENSION_CRASHED: ${t("扩展宿主已停止")}`));
      this.activation = null;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`E_EXTENSION_CRASHED: ${t("扩展宿主已停止")}`));
      this.pending.delete(id);
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.activeExtensionId = null;
  }

  private async ensureChild(): Promise<UtilityProcess> {
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.runnerPath, [], {
      serviceName: "Panda Extension Host",
    });
    child.on("message", (message: unknown) => this.handleMessage(message));
    child.on("exit", (code: number) => {
      this.onLog(`[extension-host] exit ${code}`);
      this.failAll(new Error(`E_EXTENSION_CRASHED: ${t("扩展宿主进程已退出")}`));
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = null;
        this.dispose();
        reject(new Error(`E_EXTENSION_ACTIVATION_FAILED: ${t("扩展宿主启动超时")}`));
      }, ACTIVATION_TIMEOUT_MS);
      this.ready = { resolve, reject, timer };
    });
    return child;
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const data = message as {
      type?: string;
      requestId?: number;
      message?: string;
      data?: unknown;
      level?: string;
    };
    switch (data.type) {
      case "ready": {
        if (this.ready) {
          clearTimeout(this.ready.timer);
          this.ready.resolve();
          this.ready = null;
        }
        return;
      }
      case "activated": {
        if (this.activation) {
          clearTimeout(this.activation.timer);
          this.activation.resolve();
          this.activation = null;
        }
        return;
      }
      case "activation-error": {
        if (this.activation) {
          clearTimeout(this.activation.timer);
          this.activation.reject(
            new Error(`E_EXTENSION_ACTIVATION_FAILED: ${data.message ?? t("扩展激活失败")}`),
          );
          this.activation = null;
        }
        return;
      }
      case "result": {
        const pending = data.requestId !== undefined ? this.pending.get(data.requestId) : undefined;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(data.requestId as number);
        pending.resolve(data.data);
        return;
      }
      case "call-error": {
        const pending = data.requestId !== undefined ? this.pending.get(data.requestId) : undefined;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(data.requestId as number);
        pending.reject(new Error(`E_EXTENSION_ACTIVATION_FAILED: ${data.message ?? t("扩展调用失败")}`));
        return;
      }
      case "log": {
        this.onLog(`[${data.level ?? "info"}] ${data.message ?? ""}`);
        return;
      }
      default:
        return;
    }
  }

  private failAll(error: Error): void {
    this.child = null;
    if (this.ready) {
      clearTimeout(this.ready.timer);
      this.ready.reject(error);
      this.ready = null;
    }
    if (this.activation) {
      clearTimeout(this.activation.timer);
      this.activation.reject(error);
      this.activation = null;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.activeExtensionId = null;
  }
}
