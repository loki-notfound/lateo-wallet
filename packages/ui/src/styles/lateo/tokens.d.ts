// Built by scripts/build.mjs from tokens/tokens.json and products.json.
export type ThemeName = "light" | "dark";
export type ProductId = "home" | "node" | "wallet" | "map" | "explorer" | "stats";
export type AssetId = "zeph" | "zsd" | "zrs" | "zys";
export type BreakpointKey = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

export interface StatusColorGroup {
  readonly bg: string;
  readonly line: string;
  readonly fg: string;
}

export interface MapThemeColors {
  readonly land: string;
  readonly water: string;
  readonly border: string;
  readonly graticule: string;
  readonly kind: MapKindColors;
}

export interface MapKindColors {
  readonly p2p: string;
  readonly rpc: string;
  readonly both: string;
  readonly private: string;
}

export interface ReserveRatioStates {
  readonly healthy: StatusColorGroup;
  readonly warning: StatusColorGroup;
  readonly critical: StatusColorGroup;
}

export interface ThemeTokens {
  readonly bg: string;
  readonly surface: string;
  readonly surfaceSubtle: string;
  readonly codeBg: string;
  readonly fg: string;
  readonly muted: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly accent: string;
  readonly accentHover: string;
  readonly accentFg: string;
  readonly focus: string;
  readonly overlay: string;
  readonly shadowSm: string;
  readonly shadowMd: string;
  readonly info: StatusColorGroup;
  readonly success: StatusColorGroup;
  readonly warning: StatusColorGroup;
  readonly danger: StatusColorGroup;
  readonly map: MapThemeColors;
  readonly reserveRatio: ReserveRatioStates;
}

export interface ChartPalette {
  readonly categorical: Readonly<Record<"1" | "2" | "3" | "4" | "5" | "6" | "7" | "8", string>>;
  readonly sequential: Readonly<Record<"1" | "2" | "3" | "4" | "5", string>>;
  readonly diverging: Readonly<Record<"1" | "2" | "3" | "4" | "5", string>>;
}

export interface AssetToken {
  readonly color: string;
  readonly ticker: string;
  readonly label: string;
  readonly badge: string;
}

export interface ProductColorMap {
  readonly "home": string;
  readonly "node": string;
  readonly "wallet": string;
  readonly "map": string;
  readonly "explorer": string;
  readonly "stats": string;
  readonly "spare-1": string;
  readonly "spare-2": string;
}

export interface MapMarkerColors {
  readonly online: string;
  readonly degraded: string;
  readonly offline: string;
  readonly unknown: string;
  readonly cluster: string;
  readonly selection: string;
}

export interface TokenScales {
  readonly font: { readonly sans: string; readonly mono: string };
  readonly typeScale: Readonly<Record<string, string>>;
  readonly leading: Readonly<Record<string, number>>;
  readonly space: Readonly<Record<string, string>>;
  readonly measure: { readonly narrow: string; readonly prose: string; readonly wide: string };
  readonly radius: Readonly<Record<string, string>>;
  readonly borderWidth: { readonly hairline: string; readonly focus: string };
  readonly focus: { readonly width: string; readonly offset: string };
  readonly motion: { readonly durationFast: string; readonly durationBase: string; readonly easing: string };
  readonly zIndex: Readonly<Record<string, number>>;
}

export interface ProductEntry {
  readonly id: ProductId;
  readonly name: string;
  readonly hostname: string;
  readonly url: string;
  readonly kind: string;
  readonly description: string;
  readonly colorToken: string;
  readonly icon: string;
}

export declare const light: ThemeTokens;
export declare const dark: ThemeTokens;
export declare const themes: { readonly light: ThemeTokens; readonly dark: ThemeTokens };
export declare const chart: ChartPalette;
export declare const assets: Readonly<Record<AssetId, AssetToken>>;
export declare const productColors: ProductColorMap;
export declare const mapMarkers: MapMarkerColors;
export declare const breakpoints: Readonly<Record<BreakpointKey, string>>;
export declare const breakpointPx: Readonly<Record<BreakpointKey, number>>;
export declare const scales: TokenScales;
export declare const products: readonly ProductEntry[];
export declare const tokens: {
  readonly light: ThemeTokens;
  readonly dark: ThemeTokens;
  readonly themes: { readonly light: ThemeTokens; readonly dark: ThemeTokens };
  readonly chart: ChartPalette;
  readonly assets: Readonly<Record<AssetId, AssetToken>>;
  readonly productColors: ProductColorMap;
  readonly mapMarkers: MapMarkerColors;
  readonly breakpoints: Readonly<Record<BreakpointKey, string>>;
  readonly breakpointPx: Readonly<Record<BreakpointKey, number>>;
  readonly scales: TokenScales;
  readonly products: readonly ProductEntry[];
};
export declare function getThemeTokens(theme: ThemeName): ThemeTokens;
