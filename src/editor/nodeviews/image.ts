import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { t } from "../../i18n";

/** 图片解析结果：小图直接给 data URL；超过阈值的大图等用户点击后再读取。 */
export type ImageResolveResult =
  | { kind: "url"; url: string }
  | { kind: "large"; size: number; load: () => Promise<string | null> };

/**
 * 图片 NodeView：绝对地址直接显示；相对路径交给 `resolveImage`（文档目录 → data URL）。
 * 大图先显示占位与「加载图片」按钮，避免一次性把几十 MB 读进 DOM。
 * 解析失败时显示占位提示，不阻塞编辑。见 doc/design.md §11.3。
 */
export class ImageNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly placeholder: HTMLElement;
  private readonly placeholderText: HTMLElement;
  private readonly loadButton: HTMLButtonElement;
  private node: PMNode;
  private src = "";
  private token = 0;
  private loading = false;
  private largeLoad: (() => Promise<string | null>) | null = null;

  constructor(
    node: PMNode,
    private readonly resolve: (src: string) => Promise<ImageResolveResult | null>,
    private readonly onDestroy?: () => void,
  ) {
    this.node = node;
    this.dom = document.createElement("span");
    this.dom.className = "image-node";
    this.img = document.createElement("img");
    this.img.draggable = false;

    this.placeholder = document.createElement("span");
    this.placeholder.className = "image-node-placeholder";
    this.placeholder.hidden = true;
    this.placeholderText = document.createElement("span");
    this.placeholderText.className = "image-node-placeholder-text";
    this.loadButton = document.createElement("button");
    this.loadButton.type = "button";
    this.loadButton.className = "button small";
    this.loadButton.textContent = t("加载图片");
    this.loadButton.addEventListener("mousedown", (event) => event.preventDefault());
    this.loadButton.addEventListener("click", () => this.loadLargeImage());
    this.placeholder.append(this.placeholderText, this.loadButton);

    this.dom.append(this.img, this.placeholder);
    this.render();
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "image") return false;
    this.node = node;
    this.render();
    return true;
  }

  destroy(): void {
    this.onDestroy?.();
  }

  /** 占位按钮的点击不交给 ProseMirror，避免被当成节点选择。 */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.placeholder.contains(event.target);
  }

  /** 文档路径变化（另存为/重命名）后重新解析相对路径。 */
  reload(): void {
    this.src = "";
    this.render();
  }

  private render(): void {
    const src = String(this.node.attrs["src"] ?? "");
    const alt = String(this.node.attrs["alt"] ?? "");
    // 空 alt 时不写属性，保留 Chromium 对加载失败图片的占位图标。
    if (alt) this.img.alt = alt;
    else this.img.removeAttribute("alt");
    this.img.title = String(this.node.attrs["title"] ?? "");
    if (src === this.src) return;
    this.src = src;
    const token = ++this.token;
    this.largeLoad = null;
    this.loading = false;
    this.dom.dataset["error"] = "";
    this.dom.classList.remove("image-node-error");
    this.placeholder.hidden = true;
    if (!src) {
      this.img.removeAttribute("src");
      return;
    }
    if (/^(?:[a-z]+:)?\/\//iu.test(src) || /^(?:data|blob):/iu.test(src)) {
      this.img.src = src;
      return;
    }
    // 相对路径按文档目录解析；失败时保留 alt 文本并标记错误态。
    void this.resolve(src)
      .then((result) => {
        if (token !== this.token || !this.dom.isConnected) return;
        if (!result) {
          this.markError();
          return;
        }
        if (result.kind === "url") {
          this.img.src = result.url;
          return;
        }
        this.showLarge(result.size, result.load);
      })
      .catch(() => {
        if (token === this.token) this.markError();
      });
  }

  /** 大图占位：显示大小并提供按需加载，不预先读入 data URL。 */
  private showLarge(size: number, load: () => Promise<string | null>): void {
    this.img.removeAttribute("src");
    this.placeholderText.textContent = t(
      "图片较大（{0} MB），未自动加载",
      (size / (1024 * 1024)).toFixed(1),
    );
    this.placeholder.hidden = false;
    this.largeLoad = load;
  }

  private loadLargeImage(): void {
    const load = this.largeLoad;
    if (!load || this.loading) return;
    this.loading = true;
    this.loadButton.disabled = true;
    const token = this.token;
    void load()
      .then((url) => {
        if (token !== this.token) return;
        if (!url) {
          this.markError();
          return;
        }
        this.img.src = url;
        this.placeholder.hidden = true;
      })
      .catch(() => {
        if (token === this.token) this.markError();
      })
      .finally(() => {
        this.loading = false;
        this.loadButton.disabled = false;
      });
  }

  /** 失败占位文案由 CSS `attr(data-error)` 渲染，跟随界面语言。 */
  private markError(): void {
    this.largeLoad = null;
    this.placeholder.hidden = true;
    this.dom.dataset["error"] = t("图片无法加载");
    this.dom.classList.add("image-node-error");
  }
}
