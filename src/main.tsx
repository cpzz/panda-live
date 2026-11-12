import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "katex/dist/katex.min.css";
import "./styles/base.css";
import "./styles/markdown.css";

// macOS hiddenInset 红绿灯位于左上，工具栏需预留空间；见 doc/design.md §12.2。
if (navigator.platform.startsWith("Mac")) {
  document.documentElement.classList.add("platform-mac");
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("缺少 #root 容器");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
