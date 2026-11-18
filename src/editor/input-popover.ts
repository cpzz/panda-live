import { t } from "../i18n";

export interface InputPopoverOptions {
  label: string;
  placeholder?: string;
  initialValue?: string;
  /** 移除按钮文案，默认「移除」。 */
  removeLabel?: string;
  /** 提供后显示「移除」按钮（如移除链接）。 */
  onRemove?: () => void;
  onApply(value: string): void;
}

/**
 * 轻量输入弹层：链接地址、图片地址等单值编辑。
 * 与格式工具栏同为 fixed 定位的原生 DOM，避免 ProseMirror 与 React 状态同步。
 */
export class InputPopover {
  readonly dom: HTMLDivElement;
  private readonly label: HTMLLabelElement;
  private readonly input: HTMLInputElement;
  private readonly removeButton: HTMLButtonElement;
  private current: InputPopoverOptions | null = null;
  /** 点击弹层外部关闭；仅打开期间注册。 */
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.dom.contains(event.target as Node)) this.hide();
  };
  /** 焦点在按钮上时 Escape 也能关闭。 */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.hide();
  };

  constructor() {
    this.dom = document.createElement("div");
    this.dom.className = "input-popover";
    this.dom.hidden = true;

    this.label = document.createElement("label");
    this.label.className = "input-popover-label";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "input-popover-input";
    this.input.spellcheck = false;

    const actions = document.createElement("div");
    actions.className = "input-popover-actions";
    this.removeButton = document.createElement("button");
    this.removeButton.type = "button";
    this.removeButton.className = "button small ghost";
    this.removeButton.textContent = t("移除");
    this.removeButton.addEventListener("mousedown", (event) => event.preventDefault());
    this.removeButton.addEventListener("click", () => {
      this.current?.onRemove?.();
      this.hide();
    });
    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.className = "button small primary";
    applyButton.textContent = t("应用");
    applyButton.addEventListener("mousedown", (event) => event.preventDefault());
    applyButton.addEventListener("click", () => this.apply());
    actions.append(this.removeButton, applyButton);

    this.dom.append(this.label, this.input, actions);
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.hide();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.apply();
      }
    });
  }

  get isOpen(): boolean {
    return !this.dom.hidden;
  }

  show(options: InputPopoverOptions, position: { left: number; top: number }): void {
    this.current = options;
    this.label.textContent = options.label;
    this.input.placeholder = options.placeholder ?? "";
    this.input.value = options.initialValue ?? "";
    this.removeButton.hidden = !options.onRemove;
    this.removeButton.textContent = options.removeLabel ?? t("移除");
    this.dom.hidden = false;

    // 垂直方向同样钳制在视口内：光标贴近文档底部时 coordsAtPos 可能返回视口外的坐标。
    const width = this.dom.offsetWidth || 280;
    const height = this.dom.offsetHeight || 120;
    const left = Math.max(8, Math.min(position.left, window.innerWidth - width - 8));
    this.dom.style.left = `${Math.round(left)}px`;
    const top = Math.max(8, Math.min(position.top, window.innerHeight - height - 8));
    this.dom.style.top = `${Math.round(top)}px`;
    this.input.focus();
    this.input.select();
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  private apply(): void {
    const options = this.current;
    if (!options) return;
    const value = this.input.value.trim();
    if (!value) {
      options.onRemove?.();
      this.hide();
      return;
    }
    options.onApply(value);
    this.hide();
  }

  hide(): void {
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.dom.hidden = true;
    this.current = null;
  }

  destroy(): void {
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.dom.remove();
  }
}
