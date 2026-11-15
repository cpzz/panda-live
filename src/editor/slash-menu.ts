import type { EditorView } from "prosemirror-view";
import type { BlockAction } from "./block-toolbar";
import { t } from "../i18n";

/**
 * 斜杠菜单：在空段落输入 `/` 时出现，选择块级结构。
 * fixed 定位的原生 DOM；键盘上下选择、Enter 应用、Esc 关闭。
 */
export class SlashMenu {
  readonly dom: HTMLDivElement;
  private actions: BlockAction[] = [];
  private buttons: HTMLButtonElement[] = [];
  private index = 0;
  /** 点击菜单外部或编辑器滚动时关闭：菜单是 fixed 定位，位置会随之失效。 */
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.dom.contains(event.target as Node)) this.hide();
  };
  private readonly onScroll = (event: Event): void => {
    if (event.target instanceof Node && this.dom.contains(event.target)) return;
    this.hide();
  };

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "slash-menu";
    this.dom.setAttribute("role", "listbox");
    this.dom.setAttribute("aria-label", t("斜杠命令"));
    this.dom.hidden = true;
  }

  get isOpen(): boolean {
    return !this.dom.hidden;
  }

  open(actions: BlockAction[], position: { left: number; top: number }): void {
    this.actions = actions;
    this.index = 0;
    this.buttons = [];
    this.dom.replaceChildren();
    if (actions.length === 0) {
      this.hide();
      return;
    }
    actions.forEach((action, actionIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slash-menu-item";
      button.setAttribute("role", "option");
      button.textContent = action.title;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        this.index = actionIndex;
        this.pick();
      });
      this.dom.append(button);
      this.buttons.push(button);
    });
    this.dom.hidden = false;
    this.updateHighlight();

    const width = this.dom.offsetWidth || 200;
    const height = this.dom.offsetHeight || 240;
    const left = Math.max(8, Math.min(position.left, window.innerWidth - width - 8));
    const top = Math.min(position.top, window.innerHeight - height - 8);
    this.dom.style.left = `${Math.round(left)}px`;
    this.dom.style.top = `${Math.round(Math.max(8, top))}px`;
    document.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("scroll", this.onScroll, true);
  }

  /** 返回 true 表示按键已被菜单消费。 */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.index = (this.index + delta + this.actions.length) % this.actions.length;
      this.updateHighlight();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.pick();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.hide();
      return true;
    }
    if (event.key === "Backspace" || event.key.length === 1) {
      // 继续输入即关闭菜单，字符照常插入。
      this.hide();
      return false;
    }
    return false;
  }

  private updateHighlight(): void {
    this.buttons.forEach((button, buttonIndex) => {
      const active = buttonIndex === this.index;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    this.buttons[this.index]?.scrollIntoView({ block: "nearest" });
  }

  private pick(): void {
    const action = this.actions[this.index];
    this.hide();
    if (!action) return;
    action.command(this.view.state, this.view.dispatch, this.view);
    this.view.focus();
  }

  hide(): void {
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("scroll", this.onScroll, true);
    this.dom.hidden = true;
    this.actions = [];
    this.buttons = [];
    this.index = 0;
  }

  destroy(): void {
    this.hide();
    this.dom.remove();
  }
}
