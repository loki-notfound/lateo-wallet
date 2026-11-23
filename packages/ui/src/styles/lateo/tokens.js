// Built by scripts/build.mjs from tokens/tokens.json and products.json.
export const light = Object.freeze({
  "bg": "#fbfbfa",
  "surface": "#ffffff",
  "surfaceSubtle": "#f4f4f1",
  "codeBg": "#f1f1ee",
  "fg": "#1c1d1f",
  "muted": "#5d6066",
  "line": "#e2e2df",
  "lineStrong": "#7e8187",
  "accent": "#2456c7",
  "accentHover": "#1c45a6",
  "accentFg": "#ffffff",
  "focus": "#2456c7",
  "overlay": "rgba(18, 19, 21, 0.56)",
  "shadowSm": "0 1px 2px rgba(18, 19, 21, 0.06)",
  "shadowMd": "0 8px 24px rgba(18, 19, 21, 0.14)",
  "info": {
    "bg": "#eef4ff",
    "line": "#2456c7",
    "fg": "#1b44a3"
  },
  "success": {
    "bg": "#ebf7f0",
    "line": "#1f7a4c",
    "fg": "#125936"
  },
  "warning": {
    "bg": "#fff7e6",
    "line": "#9e6700",
    "fg": "#704400"
  },
  "danger": {
    "bg": "#fdf0ef",
    "line": "#c2322b",
    "fg": "#941e19"
  },
  "map": {
    "land": "#e7e7e4",
    "water": "#f4f4f1",
    "border": "#9ea299",
    "graticule": "#b7bab1",
    "kind": {
      "p2p": "#2362e4",
      "rpc": "#b86800",
      "both": "#b04d8c",
      "private": "#0b7a52"
    }
  },
  "reserveRatio": {
    "healthy": {
      "bg": "#ebf7f0",
      "line": "#1f7a4c",
      "fg": "#125936"
    },
    "warning": {
      "bg": "#fff7e6",
      "line": "#9e6700",
      "fg": "#704400"
    },
    "critical": {
      "bg": "#fdf0ef",
      "line": "#c2322b",
      "fg": "#941e19"
    }
  }
});
export const dark = Object.freeze({
  "bg": "#121315",
  "surface": "#191a1d",
  "surfaceSubtle": "#202226",
  "codeBg": "#202226",
  "fg": "#e7e7e4",
  "muted": "#a0a3a9",
  "line": "#2a2c30",
  "lineStrong": "#6e727b",
  "accent": "#8fb0ff",
  "accentHover": "#abc4ff",
  "accentFg": "#121315",
  "focus": "#8fb0ff",
  "overlay": "rgba(0, 0, 0, 0.72)",
  "shadowSm": "0 1px 2px rgba(0, 0, 0, 0.35)",
  "shadowMd": "0 8px 24px rgba(0, 0, 0, 0.50)",
  "info": {
    "bg": "#172235",
    "line": "#6292f7",
    "fg": "#99b9ff"
  },
  "success": {
    "bg": "#14261d",
    "line": "#3fa972",
    "fg": "#6bd29b"
  },
  "warning": {
    "bg": "#2a2416",
    "line": "#d69824",
    "fg": "#f0bf5e"
  },
  "danger": {
    "bg": "#2e1819",
    "line": "#e86b64",
    "fg": "#ff9b95"
  },
  "map": {
    "land": "#1d2026",
    "water": "#131519",
    "border": "#555a65",
    "graticule": "#444953",
    "kind": {
      "p2p": "#2362e4",
      "rpc": "#d2760f",
      "both": "#b04d8c",
      "private": "#2aa97a"
    }
  },
  "reserveRatio": {
    "healthy": {
      "bg": "#14261d",
      "line": "#3fa972",
      "fg": "#6bd29b"
    },
    "warning": {
      "bg": "#2a2416",
      "line": "#d69824",
      "fg": "#f0bf5e"
    },
    "critical": {
      "bg": "#2e1819",
      "line": "#e86b64",
      "fg": "#ff9b95"
    }
  }
});
export const themes = Object.freeze({ light, dark });
export const chart = Object.freeze({
  "categorical": {
    "1": "#2362e4",
    "2": "#08794a",
    "3": "#d2760f",
    "4": "#b04d8c",
    "5": "#1892d8",
    "6": "#c43b1f",
    "7": "#7060b7",
    "8": "#768c65"
  },
  "sequential": {
    "1": "#4d95b8",
    "2": "#4186c2",
    "3": "#3878c9",
    "4": "#316bd2",
    "5": "#2c62db"
  },
  "diverging": {
    "1": "#c6482b",
    "2": "#cc7e24",
    "3": "#7c8088",
    "4": "#36949e",
    "5": "#3068dc"
  }
});
export const assets = Object.freeze({
  "zeph": {
    "color": "#2362e4",
    "ticker": "ZPH",
    "label": "Zephyr",
    "badge": "assets/badges/zeph.svg"
  },
  "zsd": {
    "color": "#08794a",
    "ticker": "ZSD",
    "label": "Stable Dollar",
    "badge": "assets/badges/zsd.svg"
  },
  "zrs": {
    "color": "#d2760f",
    "ticker": "ZRS",
    "label": "Reserve Share",
    "badge": "assets/badges/zrs.svg"
  },
  "zys": {
    "color": "#b04d8c",
    "ticker": "ZYS",
    "label": "Yield Share",
    "badge": "assets/badges/zys.svg"
  }
});
export const productColors = Object.freeze({
  "home": "#606a7a",
  "node": "#2c64d8",
  "wallet": "#148268",
  "map": "#167db0",
  "explorer": "#635cc4",
  "stats": "#a6630d",
  "spare-1": "#9e4b8a",
  "spare-2": "#ba513d"
});
export const mapMarkers = Object.freeze({
  "online": "#14875e",
  "degraded": "#b86800",
  "offline": "#c84038",
  "unknown": "#747985",
  "cluster": "#346de0",
  "selection": "#a64cc0"
});
export const breakpoints = Object.freeze({
  "xs": "320px",
  "sm": "375px",
  "md": "640px",
  "lg": "768px",
  "xl": "1024px",
  "2xl": "1280px"
});
export const breakpointPx = Object.freeze({
  "xs": 320,
  "sm": 375,
  "md": 640,
  "lg": 768,
  "xl": 1024,
  "2xl": 1280
});
export const scales = Object.freeze({
  "font": {
    "sans": "system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif",
    "mono": "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
  },
  "typeScale": {
    "xs": "0.75rem",
    "sm": "0.875rem",
    "md": "1rem",
    "lg": "1.125rem",
    "h3": "clamp(1.05rem, 0.98rem + 0.35vw, 1.2rem)",
    "h2": "clamp(1.25rem, 1.15rem + 0.5vw, 1.5rem)",
    "h1": "clamp(1.65rem, 1.45rem + 1vw, 2.15rem)",
    "display": "clamp(1.75rem, 1.5rem + 1.25vw, 2.5rem)",
    "compact": "0.875rem",
    "compactSm": "0.8125rem"
  },
  "leading": {
    "tight": 1.25,
    "snug": 1.4,
    "compact": 1.45,
    "code": 1.5,
    "normal": 1.6
  },
  "space": {
    "1": "0.25rem",
    "2": "0.5rem",
    "3": "0.75rem",
    "4": "1rem",
    "5": "1.25rem",
    "6": "1.5rem",
    "8": "2rem",
    "10": "2.5rem",
    "12": "3rem"
  },
  "measure": {
    "narrow": "40rem",
    "prose": "56rem",
    "wide": "90rem"
  },
  "radius": {
    "sm": "4px",
    "md": "8px",
    "lg": "10px",
    "pill": "999px"
  },
  "borderWidth": {
    "hairline": "1px",
    "focus": "2px"
  },
  "focus": {
    "width": "2px",
    "offset": "2px"
  },
  "motion": {
    "durationFast": "120ms",
    "durationBase": "180ms",
    "easing": "cubic-bezier(0.2, 0, 0, 1)"
  },
  "zIndex": {
    "base": 0,
    "sticky": 10,
    "nav": 20,
    "popover": 30,
    "modal": 40,
    "toast": 50
  }
});
export const products = Object.freeze([
  {
    "id": "home",
    "name": "lateo",
    "hostname": "lateo.dev",
    "url": "https://lateo.dev/",
    "kind": "static",
    "description": "Independent operator hub, project overview, public key, and contact.",
    "colorToken": "product.home",
    "icon": "home"
  },
  {
    "id": "node",
    "name": "node",
    "hostname": "node.lateo.dev",
    "url": "https://node.lateo.dev/",
    "kind": "static",
    "description": "Free public remote Zephyr node and guides to running your own.",
    "colorToken": "product.node",
    "icon": "node"
  },
  {
    "id": "wallet",
    "name": "wallet",
    "hostname": "wallet.lateo.dev",
    "url": "https://wallet.lateo.dev/",
    "kind": "app",
    "description": "Web and desktop Zephyr wallet for four assets and conversions.",
    "colorToken": "product.wallet",
    "icon": "wallet"
  },
  {
    "id": "map",
    "name": "map",
    "hostname": "map.lateo.dev",
    "url": "https://map.lateo.dev/",
    "kind": "app",
    "description": "World map and status directory of public Zephyr nodes.",
    "colorToken": "product.map",
    "icon": "map"
  },
  {
    "id": "explorer",
    "name": "explorer",
    "hostname": "explorer.lateo.dev",
    "url": "https://explorer.lateo.dev/",
    "kind": "server-rendered",
    "description": "Zephyr block, transaction, and mempool explorer.",
    "colorToken": "product.explorer",
    "icon": "explorer"
  },
  {
    "id": "stats",
    "name": "stats",
    "hostname": "stats.lateo.dev",
    "url": "https://stats.lateo.dev/",
    "kind": "data",
    "description": "Chain supply, reserve ratio, asset shares, and hard fork metrics.",
    "colorToken": "product.stats",
    "icon": "stats"
  }
]);

export const tokens = Object.freeze({
  light,
  dark,
  themes,
  chart,
  assets,
  productColors,
  mapMarkers,
  breakpoints,
  breakpointPx,
  scales,
  products,
});

/** Returns semantic and component color tokens for light or dark theme. */
export function getThemeTokens(theme) {
  return theme === "dark" ? dark : light;
}
