// The one place layer colors are defined. Every layer gets one fixed color
// from the BitPrairie palette. The same hex is used for the layer selector
// swatch, the legend chip and the map paint, in light and dark themes alike,
// for every visitor. Nothing derives a color from theme, saved settings,
// list order, the URL or an agency's renderer.
//
// Each color is a mid-tone with at least 3:1 contrast against both theme
// backgrounds (light paper/card/basemap and dark paper/card/basemap), so it
// never needs a dark-theme variant. Themes may change the outline around a
// swatch, never the swatch itself. test/palette.test.ts checks all of this.

export const LAYER_COLORS = {
  // wolf activity
  "cdfw-collared-wolf-cells": "#a2642f", // prairie brown
  "wdfw-wolf-packs-current": "#3e66d2", // blue
  "mtfwp-wolf-distribution": "#8858bf", // violet
  "usfws-mexican-wolf-occupied-range-2020": "#148b7b", // teal
  // wolf management areas
  "usfws-mwepa": "#b1750e", // ochre
  "idfg-wolf-management-zones": "#6a7687", // slate
  "mtfwp-wolf-management-units": "#a8518b", // plum
  "wgfd-wolf-hunt-areas": "#768627", // olive
  "widnr-wolf-management-zones": "#3e8990", // lake teal
  // bears
  "mtfwp-grizzly-occupied-range-2024": "#8d6049", // cocoa
  "mtfwp-bear-distribution": "#9c5aa6", // orchid
  "cdfw-black-bear-range": "#4a756a", // spruce
  "udwr-black-bear-habitat": "#7c7538", // dark khaki
  // context, agency data
  "nifc-wildfire-perimeters": "#c93424", // fire red
  "nws-watches-warnings": "#9f8812", // mustard
  // context, agency map services
  "blm-surface-management-agency": "#a4814f", // sand
  "blm-grazing-allotments": "#c95523", // rust
  "usfs-range-allotments": "#428833", // forest green
  "usgs-padus-manager-type": "#26834c", // protected-area green
  "census-county-boundaries": "#7e73b4", // muted indigo
  "census-tribal-lands": "#cb3365", // rose
  "usgs-shaded-relief": "#7f7b76", // stone gray
  "usgs-hydrography": "#0589c2", // water blue
  "mrlc-nlcd-land-cover": "#6d8d4c", // sage
} as const satisfies Record<string, `#${string}`>;

export type LayerColorId = keyof typeof LAYER_COLORS;

/** Fixed color for a layer id. Throws for an id with no palette entry, so a new layer cannot ship without one. */
export function layerColor(id: LayerColorId): string {
  const c = LAYER_COLORS[id];
  if (!c) throw new Error(`No palette color for layer ${id}; add one to src/config/palette.ts`);
  return c;
}

/** Interface colors that must not change with the theme (checked layer toggles). */
/**
 * "Who manages the land": one fixed color per managing agency, used for the
 * mini legend, the map (drawn by BLM's server in these colors) and the popup.
 * Same contrast rule as the layer colors.
 */
export const LAND_MANAGER_COLORS = {
  blm: "#937915", // gold
  usfs: "#3d813a", // forest green
  nps: "#8a59b5", // violet
  usfws: "#277d87", // refuge teal
  dod: "#c14679", // magenta
  bor: "#60802b", // olive
  tribal: "#a35e36", // rust
  state: "#3272c7", // blue
  other: "#7d7873", // warm gray
} as const satisfies Record<string, `#${string}`>;

export const CONTROL_COLORS = {
  /** Checked toggle fill and border. 3:1 or better on both theme backgrounds; white check on it is 5:1. */
  checked: "#926137",
  /** Check mark on the checked fill. */
  check: "#ffffff",
} as const;

/** Theme backgrounds the palette is checked against. */
export const THEME_BACKGROUNDS = {
  light: ["#ffffff", "#f3f4f6", "#f2f3f0"],
  dark: ["#0e1012", "#15181b", "#1b1d20"],
} as const;

/**
 * Installed-app colors (web app manifest, iOS meta tags, store app splash
 * screens and icons). The theme and background are the light paper color;
 * the icon is the BitPrairie bison tile on its warm plate (never recolored). test/stage7-app.test.ts checks
 * that public/manifest.webmanifest and capacitor.config.ts use these.
 */
export const APP_COLORS = {
  /** Browser and status bar color; also the manifest theme_color. */
  theme: THEME_BACKGROUNDS.light[1],
  /** Splash and window background before the page paints. */
  background: THEME_BACKGROUNDS.light[1],
  /** Dark theme bar color (meta theme-color data-dark). */
  themeDark: THEME_BACKGROUNDS.dark[0],
  /** The BitPrairie mark plate behind the bison symbol (brand fixed, light and dark). */
  icon: "#c4ae96",
} as const;

/** "#rrggbb" to [r, g, b, a] for ArcGIS symbol JSON. */
export function esriRgba(hex: string, alpha = 255): [number, number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(alpha) as [number, number, number, number];
}
