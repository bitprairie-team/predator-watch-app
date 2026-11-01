// Simple and Expert views, and the non-color cue for each layer.
//
// Simple view (the default for first-time visitors) shows a short set of
// layers in three groups, with plain-language names and one-sentence popups.
// Expert view shows every layer with full metadata. Both views use the same
// layer ids, so colors (src/config/palette.ts) and the layers that are on by
// default are identical in either view.
import type { LayerColorId } from "./palette";

export interface SimpleLayer {
  /** Plain-language name shown in Simple view. */
  name: string;
  /** One short line under the name. */
  summary: string;
  /** Popup sentence for an area of this layer. */
  popup: string;
}

export const SIMPLE_GROUPS: { id: string; name: string; layers: LayerColorId[] }[] = [
  {
    id: "wolves",
    name: "Wolves",
    layers: ["cdfw-collared-wolf-cells", "wdfw-wolf-packs-current", "mtfwp-wolf-distribution", "usfws-mexican-wolf-occupied-range-2020"],
  },
  {
    id: "bears",
    name: "Bears",
    layers: ["mtfwp-grizzly-occupied-range-2024", "mtfwp-bear-distribution", "cdfw-black-bear-range", "udwr-black-bear-habitat"],
  },
  {
    id: "land",
    name: "Land, fire and weather",
    layers: ["blm-surface-management-agency", "nifc-wildfire-perimeters", "nws-watches-warnings"],
  },
];

export const SIMPLE_LAYERS: Partial<Record<LayerColorId, SimpleLayer>> = {
  "cdfw-collared-wolf-cells": {
    name: "Where wolves have been seen",
    summary: "Areas where collared wolves were located recently. Shown as large cells, not exact spots.",
    popup: "Wolves were reported in this area.",
  },
  "wdfw-wolf-packs-current": {
    name: "Wolf pack areas",
    summary: "Areas used by known wolf packs this year, as drawn by the agency.",
    popup: "A known wolf pack uses this area.",
  },
  "mtfwp-wolf-distribution": {
    name: "Where wolves live",
    summary: "The general area where wolves are known to live.",
    popup: "Wolves are known to live in this area.",
  },
  "usfws-mexican-wolf-occupied-range-2020": {
    name: "Mexican wolf range",
    summary: "Where Mexican wolves were known to live in 2020.",
    popup: "Mexican wolves were known to live in this area in 2020.",
  },
  "mtfwp-grizzly-occupied-range-2024": {
    name: "Where grizzly bears live",
    summary: "The area grizzly bears were known to use in 2024.",
    popup: "Grizzly bears are known to live in this area.",
  },
  "mtfwp-bear-distribution": {
    name: "Black and grizzly bear areas",
    summary: "The general area where black bears and grizzly bears live.",
    popup: "Black bears or grizzly bears are known to live in this area.",
  },
  "cdfw-black-bear-range": {
    name: "Black bear range",
    summary: "The general range of black bears.",
    popup: "This area is in black bear range.",
  },
  "udwr-black-bear-habitat": {
    name: "Black bear habitat",
    summary: "Land the agency rates as black bear habitat.",
    popup: "The agency rates this area as black bear habitat.",
  },
  "blm-surface-management-agency": {
    name: "Who manages the land",
    summary: "Which agency manages public land. Zoom in to see it.",
    popup: "This land is managed by",
  },
  "nifc-wildfire-perimeters": {
    name: "Wildfires now",
    summary: "Outlines of current wildfires.",
    popup: "This area is inside a current wildfire outline.",
  },
  "nws-watches-warnings": {
    name: "Weather warnings",
    summary: "Current weather watches, warnings and advisories.",
    popup: "A weather watch, warning or advisory covers this area.",
  },
};

/**
 * Non-color cue for each layer, so a layer is never told apart by color
 * alone: a fill pattern (shown in the swatch and legend) and an outline
 * style (shown in the swatch and on the map). The four layers that are on by
 * default each have a different pair.
 */
export type FillMark = "solid" | "hatch" | "dots" | "cross" | "none";
export type LineMark = "solid" | "dash" | "dot" | "dashdot" | "long";
export const LAYER_MARKS: Record<LayerColorId, { fill: FillMark; line: LineMark }> = {
  "cdfw-collared-wolf-cells": { fill: "solid", line: "solid" },
  "wdfw-wolf-packs-current": { fill: "hatch", line: "dash" },
  "mtfwp-wolf-distribution": { fill: "dots", line: "dot" },
  "usfws-mexican-wolf-occupied-range-2020": { fill: "cross", line: "dashdot" },
  "usfws-mwepa": { fill: "none", line: "long" },
  "idfg-wolf-management-zones": { fill: "none", line: "dot" },
  "mtfwp-wolf-management-units": { fill: "none", line: "dashdot" },
  "wgfd-wolf-hunt-areas": { fill: "none", line: "dash" },
  "widnr-wolf-management-zones": { fill: "none", line: "solid" },
  "mtfwp-grizzly-occupied-range-2024": { fill: "hatch", line: "long" },
  "mtfwp-bear-distribution": { fill: "dots", line: "dash" },
  "cdfw-black-bear-range": { fill: "cross", line: "dot" },
  "udwr-black-bear-habitat": { fill: "solid", line: "dashdot" },
  "nifc-wildfire-perimeters": { fill: "solid", line: "solid" },
  "nws-watches-warnings": { fill: "hatch", line: "dash" },
  "blm-surface-management-agency": { fill: "solid", line: "solid" },
  "blm-grazing-allotments": { fill: "hatch", line: "solid" },
  "usfs-range-allotments": { fill: "dots", line: "solid" },
  "usgs-padus-manager-type": { fill: "cross", line: "solid" },
  "census-county-boundaries": { fill: "none", line: "dash" },
  "census-tribal-lands": { fill: "none", line: "dashdot" },
  "usgs-shaded-relief": { fill: "solid", line: "solid" },
  "usgs-hydrography": { fill: "none", line: "solid" },
  "mrlc-nlcd-land-cover": { fill: "dots", line: "solid" },
};

/** MapLibre line-dasharray for each outline style (in line widths). */
export const LINE_DASH: Record<LineMark, number[] | null> = {
  solid: null,
  dash: [3, 2],
  dot: [1, 1.5],
  dashdot: [4, 1.5, 1, 1.5],
  long: [7, 2.5],
};
