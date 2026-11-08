import type { DiagramRenderer } from "./service";
import type { RenderRequest, RenderResponse } from "./types";

export interface SandboxPoolOptions {
  /** 沙箱页面 URL；开发模式为 Vite 提供的同源页面，生产为 `panda-sandbox://render/index.html`。 */
  sandboxUrl: string;
  /** 并发槽位数，默认 2。见 doc/design.md §10.1。 */
  size?: number;
}

interface Task {
  request: RenderRequest;
  resolve(response: RenderResponse): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  onAbort(): void;
}

interface Slot {
  iframe: HTMLIFrameElement;
  ready: Promise<void>;
  readyCleanup(): void;
  task: Task | null;
}

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * 隐藏 iframe 渲染沙箱池：每个 iframe 持有独立 JS 上下文，串行处理任务，池间并行。
 * 超时由调用方 abort 信号触发，随后销毁该 iframe 并按需重建。见 doc/design.md §4.5、§10.1。
 */
export class IframeSandboxPool implements DiagramRenderer {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private readonly origin: string;
  private disposed = false;
  private readonly onMessage = (event: MessageEvent): void => this.handleMessage(event);

  constructor(private readonly options: SandboxPoolOptions) {
    this.origin = new URL(options.sandboxUrl).origin;
    if (typeof window !== "undefined") {
      window.addEventListener("message", this.onMessage);
    }
  }

  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResponse> {
    return new Promise<RenderResponse>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error("渲染沙箱池已销毁"));
        return;
      }

      const task: Task = {
        request,
        resolve,
        reject,
        signal,
        onAbort: () => undefined,
      };
      task.onAbort = () => {
        const queuedIndex = this.queue.indexOf(task);
        if (queuedIndex >= 0) {
          this.queue.splice(queuedIndex, 1);
          reject(abortError());
          return;
        }
        const slot = this.slots.find((candidate) => candidate.task === task);
        if (slot) {
          slot.task = null;
          this.recreateSlot(slot);
          reject(abortError());
          this.pump();
        }
      };
      signal.addEventListener("abort", task.onAbort, { once: true });
      this.queue.push(task);
      this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("message", this.onMessage);
    }
    for (const task of this.queue.splice(0)) {
      task.reject(abortError());
    }
    for (const slot of this.slots) {
      slot.readyCleanup();
      slot.iframe.remove();
    }
    this.slots = [];
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const slot = this.ensureIdleSlot();
      if (!slot) return;
      const task = this.queue.shift();
      if (!task) return;
      slot.task = task;
      void this.dispatch(slot, task);
    }
  }

  private ensureIdleSlot(): Slot | null {
    const existing = this.slots.find((slot) => slot.task === null);
    if (existing) return existing;
    if (this.slots.length >= (this.options.size ?? 2)) return null;
    const slot = this.createSlot();
    this.slots.push(slot);
    return slot;
  }

  private async dispatch(slot: Slot, task: Task): Promise<void> {
    try {
      await slot.ready;
      if (task.signal.aborted) return;
      slot.iframe.contentWindow?.postMessage({ type: "render", request: task.request }, this.origin);
    } catch (error) {
      if (slot.task === task) {
        slot.task = null;
        this.recreateSlot(slot);
        task.reject(error);
        this.pump();
      }
    }
  }

  private createSlot(): Slot {
    const iframe = document.createElement("iframe");
    iframe.className = "diagram-sandbox-frame";
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.title = "图表渲染沙箱";
    iframe.style.cssText =
      "position:fixed;left:-2000px;top:0;width:800px;height:600px;border:0;visibility:hidden;pointer-events:none";

    let removeReadyListener = (): void => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      const onReady = (event: MessageEvent): void => {
        if (event.source !== iframe.contentWindow) return;
        if (!this.isTrustedOrigin(event)) return;
        const data = event.data as { type?: string } | null;
        if (data?.type !== "sandbox-ready") return;
        window.removeEventListener("message", onReady);
        resolve();
      };
      removeReadyListener = () => window.removeEventListener("message", onReady);
      window.addEventListener("message", onReady);
      // 沙箱脚本异常时不会发送 ready，交由 15 s 渲染超时统一兜底。
      iframe.addEventListener("error", () => reject(new Error("图表渲染沙箱加载失败")));
    });

    ready.catch(() => undefined);

    iframe.src = this.options.sandboxUrl;
    document.body.appendChild(iframe);
    return { iframe, ready, readyCleanup: () => removeReadyListener(), task: null };
  }

  private recreateSlot(slot: Slot): void {
    const index = this.slots.indexOf(slot);
    slot.readyCleanup();
    slot.iframe.remove();
    if (index >= 0) {
      this.slots.splice(index, 1);
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (!this.isTrustedOrigin(event)) return;
    const slot = this.slots.find((candidate) => candidate.iframe.contentWindow === event.source);
    if (!slot?.task) return;

    const data = event.data as (RenderResponse | { type?: string }) | null;
    if (!data || typeof data !== "object" || (data as { type?: string }).type === "sandbox-ready") return;
    const response = data as RenderResponse;
    if (response.id !== slot.task.request.id) return;

    const task = slot.task;
    slot.task = null;
    task.signal.removeEventListener("abort", task.onAbort);
    task.resolve(response);
    this.pump();
  }

  private isTrustedOrigin(event: MessageEvent): boolean {
    return event.origin === this.origin;
  }
}
