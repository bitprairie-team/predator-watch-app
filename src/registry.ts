// Source registry: turns config entries into adapter instances and exposes the
// public, display-safe description of each source.
import { ArcGisAdapter } from "./adapters/arcgis";
import { GeoJsonAdapter } from "./adapters/geojson";
import type { SourceAdapter } from "./adapters/types";
import { SOURCES, type SourceConfig } from "./config/sources";
import type { PublicSourceInfo } from "./schema";

export type AdapterFactory = (config: SourceConfig) => SourceAdapter;

const FACTORIES: Record<SourceConfig["type"], AdapterFactory> = {
  arcgis: (c) => new ArcGisAdapter(c as Extract<SourceConfig, { type: "arcgis" }>),
  geojson: (c) => new GeoJsonAdapter(c as Extract<SourceConfig, { type: "geojson" }>),
};

export class Registry {
  private readonly byId = new Map<string, SourceAdapter>();

  constructor(configs: SourceConfig[] = SOURCES) {
    for (const c of configs) {
      if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(c.id)) throw new Error(`Invalid source id: ${c.id}`);
      if (this.byId.has(c.id)) throw new Error(`Duplicate source id: ${c.id}`);
      const factory = FACTORIES[c.type];
      if (!factory) throw new Error(`Unknown adapter type for ${c.id}`);
      this.byId.set(c.id, factory(c));
    }
  }

  get(id: string): SourceAdapter | undefined {
    return this.byId.get(id);
  }

  all(): SourceAdapter[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }
}

export function publicInfo(a: SourceAdapter): PublicSourceInfo {
  const c = a.config;
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    species: c.species,
    agency: c.agency,
    credit_short: c.creditShort ?? c.agency,
    url: a.endpoint,
    info_url: c.infoUrl,
    license: c.license,
    attribution: c.attribution,
    cadence: c.cadence,
    precision: c.precision,
    notes: c.notes,
    style: c.style,
  };
}
