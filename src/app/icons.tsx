import type { ReactNode, SVGProps } from "react";

const ICONS = {
  /** 侧栏可见：面板 + 向左收起箭头 */
  "sidebar-close": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M10 4v16" />
      <path d="M8 9.5 5.5 12 8 14.5" />
    </>
  ),
  /** 侧栏隐藏：面板 + 向右展开箭头 */
  "sidebar-open": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M10 4v16" />
      <path d="M5.5 9.5 8 12l-2.5 2.5" />
    </>
  ),
  "file-plus": (
    <>
      <path d="M6 3h7l5 5v13H6z" />
      <path d="M13 3v5h5" />
      <path d="M9.5 13.5h5M12 11v5" />
    </>
  ),
  "folder-open": (
    <>
      <path d="M3 6.5h6l2 2h10v3" />
      <path d="M3 6.5v11h14l2.5-6H6.5L4 17" />
    </>
  ),
  folder: (
    <>
      <path d="M3 5.5h6l2 2h10v11H3z" />
      <path d="M3 9h18" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h12l2 2v14H5z" />
      <path d="M8 4v6h7V4" />
      <path d="M8 20v-6h8v6" />
    </>
  ),
  "save-as": (
    <>
      <path d="M5 4h10l2 2v6" />
      <path d="M5 4v16h7" />
      <path d="M8 8h6" />
      <path d="M20 11.5 12.5 19H10v-2.5L17.5 9z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </>
  ),
  "folder-plus": (
    <>
      <path d="M3 5.5h6l2 2h10v11H3z" />
      <path d="M15 12v5M12.5 14.5h5" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20l4.2-1L19 8.2 15.8 5 5 15.8z" />
      <path d="M13.8 7l3.2 3.2" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="M6.5 7l1 13h9l1-13" />
    </>
  ),
  reveal: (
    <>
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M18 14v5H5V6h5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  "chevron-up": <path d="M6.5 14.5 12 9l5.5 5.5" />,
  "chevron-down": <path d="M6.5 9.5 12 15l5.5-5.5" />,
  "chevron-left": <path d="M14.5 6.5 9 12l5.5 5.5" />,
  "chevron-right": <path d="M9.5 6.5 15 12 9.5 17.5" />,
  list: (
    <>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </>
  ),
  "arrow-up": (
    <>
      <path d="M12 19V5" />
      <path d="m6.5 10.5 5.5-5.5 5.5 5.5" />
    </>
  ),
  "arrow-down": (
    <>
      <path d="M12 5v14" />
      <path d="m6.5 13.5 5.5 5.5 5.5-5.5" />
    </>
  ),
  replace: (
    <>
      <path d="M5 7h11a3 3 0 0 1 3 3v1" />
      <path d="m13.5 4.5 2.5 2.5-2.5 2.5" />
      <path d="M19 17H8a3 3 0 0 1-3-3v-1" />
      <path d="m10.5 19.5-2.5-2.5 2.5-2.5" />
    </>
  ),
  "replace-all": (
    <>
      <path d="M4 6h9a3 3 0 0 1 3 3v1" />
      <path d="m11.5 3.5 2.5 2.5-2.5 2.5" />
      <path d="M4 14h9a3 3 0 0 1 3 3v1" />
      <path d="m11.5 11.5 2.5 2.5-2.5 2.5" />
      <path d="M18 20h2v-2" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h7l5 5v13H6z" />
      <path d="M13 3v5h5" />
    </>
  ),
  code: (
    <>
      <path d="M8 7 3 12l5 5" />
      <path d="m16 7 5 5-5 5" />
    </>
  ),
  split: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M12 4v16" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 18 18.5 12 18.5 2.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  ...props
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {ICONS[name]}
    </svg>
  );
}
