import React from "react";

const paths = {
  command: <><path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2" /><path d="m8 8 3 4-3 4M13 16h3" /></>,
  center: <><circle cx="12" cy="12" r="8" /><path d="M12 8v8M8 12h8" /></>,
  chat: <><path d="M20 11.5a7.3 7.3 0 0 1-7.5 7.3 8 8 0 0 1-3.2-.7L4 20l1.5-4.4A7.2 7.2 0 0 1 4.5 11 7.6 7.6 0 0 1 12 4a7.6 7.6 0 0 1 8 7.5Z" /><path d="M8.5 11.5h.1M12 11.5h.1M15.5 11.5h.1" /></>,
  artifact: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>,
  sips: <><path d="M6 4h12M6 20h12M8 4v4l4 4 4-4V4M8 20v-4l4-4 4 4v4" /><path d="M10 8h4M10 16h4" /></>,
  memory: <><path d="M12 20V7M12 12c-4 0-6-2-6-5 4 0 6 2 6 5ZM12 9c0-4 2-6 6-6 0 4-2 6-6 6ZM12 15c-3 0-5 2-5 5M12 17c3 0 5 1 5 3" /></>,
  dream: <><path d="M20.7 15.2A8.7 8.7 0 0 1 8.8 3.3 8.7 8.7 0 1 0 20.7 15.2Z" /><path d="M16 3.5v3M14.5 5h3" /></>,
  activity: <polyline points="3 12 8 12 10.2 5 14.1 19 16.4 12 21 12" />,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" /><path d="M9 3v15M15 6v15" /></>,
  settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3.1 1.3v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3.1-1.3l-.1.1a1.8 1.8 0 0 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-1.3-3.1h-.2a1.8 1.8 0 0 1 0-3.6h.2A1.8 1.8 0 0 0 4.6 5l-.1-.1A1.8 1.8 0 0 1 7 2.4l.1.1a1.8 1.8 0 0 0 3.1-1.3V1a1.8 1.8 0 0 1 3.6 0v.2A1.8 1.8 0 0 0 17 2.5l.1-.1a1.8 1.8 0 0 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 1.3 3.1h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0-1.4 3.3Z" transform="translate(2 2) scale(.83)" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  minimize: <path d="M5 12h14" />,
  maximize: <><path d="M7 7h10v10H7z" /><path d="M7 10H5v9h9v-2" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  send: <><path d="m21 3-7.4 18-3.5-7.1L3 10.4 21 3Z" /><path d="M10.2 13.9 21 3" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
  play: <path d="m8 5 11 7-11 7V5Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  leaf: <><path d="M20.7 3.3C12.4 3.5 5.2 6.4 4.1 12.2c-.7 3.6 2.1 6.5 5.5 6.1 5.8-.6 8.9-7.3 11.1-15Z" /><path d="M4.2 19.7c2.3-4.6 6-8.1 10.7-10.5" /></>,
  tree: <><path d="M12 3v18M8.5 21h7" /><path d="M12 5c-1.1 1.3-2.2 2.4-3.8 3.4 1 .3 1.9.3 2.8.1-1.4 1.2-3.1 2.2-5.2 2.9 1.3.6 2.6.6 4 .2-1.5 1.4-3.3 2.5-5.4 3.2 1.5.7 3 .6 4.4.1-1.1 1.4-2.3 2.4-3.8 3.2 2.1.4 3.9-.2 5.2-1.3" /><path d="M12 5c1 1.2 2 2.2 3.6 2.9-.9.4-1.8.4-2.7.2 1.4 1.2 3 2 5 2.5-1.2.6-2.5.6-3.8.2 1.4 1.3 3.1 2.2 5.1 2.8-1.4.7-2.8.7-4.2.3 1.1 1.2 2.3 2 3.8 2.7-2 .5-3.8 0-5.1-1.1" /><path d="M9 19.5c1.9-.7 4.1-.7 6 0" /></>,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3" /></>,
  verify: <><path d="m5 12 4 4L19 6" /><path d="M4 4h16v16H4z" /></>,
  work: <><path d="M4 7h16v12H4z" /><path d="M8 7V5h8v2M8 12h8" /></>,
  warning: <><path d="m12 4 9 16H3L12 4Z" /><path d="M12 9v5M12 17h.01" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.7-4L4 9" /><path d="M4 4v5h5M4 13a8 8 0 0 0 14.7 4L20 15" /><path d="M20 20v-5h-5" /></>,
  database: <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></>,
  pulse: <polyline points="2 12 6 12 8.5 5 12.5 19 15 12 22 12" />,
};

export function Icon({ name, size = 18 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.command}</svg>;
}
