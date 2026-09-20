import React from "react";

// A single 24px optical grid. Distinct app silhouettes; action glyphs describe
// their operation rather than borrowing an unrelated app or window icon.
const paths = {
  command: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  center: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M10 9v12m4-7h3m-3 3h3" /><circle cx="6.5" cy="6" r=".6" fill="currentColor" stroke="none" /></>,
  chat: <><path d="M6 4h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-5 3v-4a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3Z" /><path d="M7 9h10M7 13h6" /></>,
  artifact: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 8h18m-12 4-3 3 3 3m6-6 3 3-3 3" /></>,
  sips: <><path d="M5 8a8 8 0 0 1 13-2l2 2m0-5v5h-5M19 16A8 8 0 0 1 6 18l-2-2m0 5v-5h5" /><path d="m10 9 4 3-4 3Z" /></>,
  memory: <><path d="M12 20V7M12 12c-4 0-6-2-6-5 4 0 6 2 6 5ZM12 9c0-4 2-6 6-6 0 4-2 6-6 6ZM12 15c-3 0-5 2-5 5M12 17c3 0 5 1 5 3" /></>,
  dream: <><path d="M20.7 15.2A8.7 8.7 0 0 1 8.8 3.3 8.7 8.7 0 1 0 20.7 15.2Z" /><path d="M16 3.5v3M14.5 5h3" /></>,
  activity: <polyline points="3 12 8 12 10.2 5 14.1 19 16.4 12 21 12" />,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  map: <><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4m-6 4v-4h12v4" /></>,
  settings: <><path d="M4 6h5m6 0h5M4 12h9m6 0h1M4 18h2m6 0h8" /><circle cx="12" cy="6" r="3" /><circle cx="16" cy="12" r="3" /><circle cx="9" cy="18" r="3" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1.5" />,
  restore: <><path d="M9 8V4h11v11h-4" /><rect x="4" y="9" width="11" height="11" rx="1" /></>,
  windows: <><rect x="3" y="8" width="13" height="12" rx="2" /><path d="M8 8V4h13v12h-5M3 12h13" /></>,
  apps: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  desktop: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
  tileLeft: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /><path d="M6 8h3v8H6z" fill="currentColor" stroke="none" opacity=".6" /></>,
  tileRight: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /><path d="M15 8h3v8h-3z" fill="currentColor" stroke="none" opacity=".6" /></>,
  centerWindow: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></>,
  resetSize: <><path d="M4 8V3m0 0h5M4 3l5 5m11 8v5m0 0h-5m5 0-5-5" /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
  keyboard: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 12h.1M10 12h.1M14 12h.1M18 12h.1M7 15h10" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v12h5" /></>,
  retry: <><path d="M4 10a8 8 0 1 1 2 8M4 4v6h6" /></>,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  moon: <path d="M20 15A8.5 8.5 0 0 1 9 4a8.5 8.5 0 1 0 11 11Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  connection: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4" /></>,
  login: <><path d="M13 4h7v16h-7M3 12h11m-4-4 4 4-4 4" /></>,
  logout: <><path d="M10 4H3v16h7m0-8h11m-4-4 4 4-4 4" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
  unknown: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  send: <><path d="m21 3-7.4 18-3.5-7.1L3 10.4 21 3Z" /><path d="M10.2 13.9 21 3" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
  play: <path d="m8 5 11 7-11 7V5Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  pencil: <><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z" /><path d="m15 5 4 4" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>,
  leaf: <><path d="M20.7 3.3C12.4 3.5 5.2 6.4 4.1 12.2c-.7 3.6 2.1 6.5 5.5 6.1 5.8-.6 8.9-7.3 11.1-15Z" /><path d="M4.2 19.7c2.3-4.6 6-8.1 10.7-10.5" /></>,
  tree: <><path d="M12 3v18M8.5 21h7" /><path d="M12 5c-1.1 1.3-2.2 2.4-3.8 3.4 1 .3 1.9.3 2.8.1-1.4 1.2-3.1 2.2-5.2 2.9 1.3.6 2.6.6 4 .2-1.5 1.4-3.3 2.5-5.4 3.2 1.5.7 3 .6 4.4.1-1.1 1.4-2.3 2.4-3.8 3.2 2.1.4 3.9-.2 5.2-1.3" /><path d="M12 5c1 1.2 2 2.2 3.6 2.9-.9.4-1.8.4-2.7.2 1.4 1.2 3 2 5 2.5-1.2.6-2.5.6-3.8.2 1.4 1.3 3.1 2.2 5.1 2.8-1.4.7-2.8.7-4.2.3 1.1 1.2 2.3 2 3.8 2.7-2 .5-3.8 0-5.1-1.1" /><path d="M9 19.5c1.9-.7 4.1-.7 6 0" /></>,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3" /></>,
  verify: <><path d="m5 12 4 4L19 6" /><path d="M4 4h16v16H4z" /></>,
  work: <><path d="M4 7h16v12H4z" /><path d="M8 7V5h8v2M8 12h8" /></>,
  warning: <><path d="m12 4 9 16H3L12 4Z" /><path d="M12 9v5M12 17h.01" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.7-4L4 9" /><path d="M4 4v5h5M4 13a8 8 0 0 0 14.7 4L20 15" /><path d="M20 20v-5h-5" /></>,
  database: <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></>,
  grove: <><path d="M12 2.5 15.4 8h-1.9l3.4 5.8H7.1l3.4-5.8H8.6L12 2.5Z" /><path d="M5.4 11.5 7.8 15.5h-1.2l2.7 4.4H1.7l2.7-4.4H3.2l2.2-4Z" /><path d="M18.6 11.5 21 15.5h-1.2l2.7 4.4h-7.6l2.7-4.4h-1.2l2.2-4Z" /><path d="M12 13.8v6.4M5.4 19.9v2.3M18.6 19.9v2.3M2.5 22.2h19" /></>,
  pulse: <polyline points="2 12 6 12 8.5 5 12.5 19 15 12 22 12" />,
};

export const ICON_NAMES = Object.freeze(Object.keys(paths));

export function Icon({ name, size = 18, label, className = "" }) {
  const resolved = Object.hasOwn(paths, name) ? name : "unknown";
  return <svg className={`hemlock-icon ${className}`.trim()} data-icon={resolved} aria-hidden={label ? undefined : true} aria-label={label || undefined} role={label ? "img" : undefined} focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{label && <title>{label}</title>}{paths[resolved]}</svg>;
}
