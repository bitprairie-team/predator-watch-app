// Location tiers for private data.
//   own ranch:     the tenant's own records at full precision.
//   shared:        other ranchers' contributed records, snapped to 1-2 mile
//                  cells and only after a 48-72 hour delay.
//   den holdback:  during den season, held-back cells are dropped with no
//                  marker; den-flagged records are never shared at all.
//   public tier:   nothing private (enforced in data.ts and the entitlement gate).
import type { Geometry } from "../schema";
import type { SharedObservation, SharingGroupPolicy } from "./model";

const MILES_PER_DEG_LAT = 69.172;

export function clampPolicy(p: SharingGroupPolicy): SharingGroupPolicy {
  return { ...p, cell_miles: Math.min(2, Math.max(1, p.cell_miles || 1.5)), delay_hours: Math.min(72, Math.max(48, p.delay_hours || 72)) };
}

export interface Cell {
  cell_id: string;
  center: { lat: number; lon: number };
  geometry: Extract<Geometry, { type: "Polygon" }>;
}

export function cellFor(lat: number, lon: number, miles: number): Cell {
  const dLat = miles / MILES_PER_DEG_LAT;
  const row = Math.floor(lat / dLat);
  const midLat = (row + 0.5) * dLat;
  const dLon = miles / (MILES_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180));
  const col = Math.floor(lon / dLon);
  const s = row * dLat, n = s + dLat, w = col * dLon, e = w + dLon;
  const r = (x: number) => Math.round(x * 1e5) / 1e5;
  return {
    cell_id: `c${miles}:${row}:${col}`,
    center: { lat: r((s + n) / 2), lon: r((w + e) / 2) },
    geometry: { type: "Polygon", coordinates: [[[r(w), r(s)], [r(e), r(s)], [r(e), r(n)], [r(w), r(n)], [r(w), r(s)]]] },
  };
}

export function inDenSeason(policy: SharingGroupPolicy, now: Date): boolean {
  if (!policy.den_season) return false;
  const md = (s: string) => {
    const [m, d] = s.split("-").map(Number);
    return (m ?? 0) * 100 + (d ?? 0);
  };
  const today = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const a = md(policy.den_season.start), b = md(policy.den_season.end);
  return a <= b ? today >= a && today <= b : today >= a || today <= b;
}

export interface SharedCell extends Cell {
  group: string;
  species: Record<string, number>;
  report_count: number;
  /** Day of the most recent report in the cell (day precision only). */
  latest_observed_on: string;
  latest_received_at: string;
  tier: "shared";
  precision: string;
}

/** Turn raw shared records into tier-safe cells. */
export function sharedCells(records: SharedObservation[], policyIn: SharingGroupPolicy, now: Date, excludeOrigin?: string): SharedCell[] {
  const policy = clampPolicy(policyIn);
  const cutoff = now.getTime() - policy.delay_hours * 3600_000;
  const den = inDenSeason(policy, now);
  const holdback = new Set(policy.holdback_cells ?? []);
  const cells = new Map<string, SharedCell>();
  const denCells = new Set<string>();
  for (const r of records) {
    if (r.group !== policy.id) continue;
    if (excludeOrigin && r.origin === excludeOrigin) continue;
    const c = cellFor(r.lat, r.lon, policy.cell_miles);
    if (r.sensitive === "den") {
      denCells.add(c.cell_id);
      continue;
    }
    const t = Date.parse(r.observed_at);
    if (!Number.isFinite(t) || t > cutoff) continue;
    const cur = cells.get(c.cell_id) ?? {
      ...c,
      group: policy.id,
      species: {},
      report_count: 0,
      latest_observed_on: "",
      latest_received_at: "",
      tier: "shared" as const,
      precision: `${policy.cell_miles}-mile cell, shown after ${policy.delay_hours} hours`,
    };
    cur.species[r.species] = (cur.species[r.species] ?? 0) + 1;
    cur.report_count++;
    const day = new Date(t).toISOString().slice(0, 10);
    if (day > cur.latest_observed_on) cur.latest_observed_on = day;
    if (r.received_at > cur.latest_received_at) cur.latest_received_at = r.received_at;
    cells.set(c.cell_id, cur);
  }
  // Den season: drop held-back cells and cells with den-flagged records, silently.
  return [...cells.values()].filter((c) => !(den && (holdback.has(c.cell_id) || denCells.has(c.cell_id))));
}
