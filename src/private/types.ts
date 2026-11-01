/**
 * Private collaboration space: TypeScript interfaces only (Planned).
 *
 * Nothing in the public Worker imports this file, and there are no rancher
 * data paths in the public build. A test checks that no public module
 * imports from src/private. See docs/private-version.md.
 */

export type OrgType =
  | "ranch"
  | "community-group"
  | "local-government"
  | "tribal-government"
  | "state-agency"
  | "federal-agency"
  | "university";

export type Role = "owner" | "admin" | "member" | "viewer";

export interface Org {
  id: string;
  name: string;
  type: OrgType;
  /** Two-letter state code(s) the org works in. */
  regions: string[];
  created_at: string;
  /** ArcGIS Online or Enterprise connection for this org, if any. */
  arcgis?: ArcGISConnection;
}

export interface PointOfContact {
  org_id: string;
  name: string;
  role_title: string;
  email: string;
  phone?: string;
  /** Hours this person can be reached, in the org's time zone. */
  hours?: string;
  /** Order to try when several contacts exist. */
  priority: number;
}

export interface Member {
  user_id: string;
  org_id: string;
  role: Role;
}

/** Location precision a party may see under an agreement. */
export type LocationTier =
  /** The rancher's own ranch, at full precision, seen only by that ranch. */
  | "own-full"
  /** Shared as grid cells 1 to 2 miles across, after a 2 to 3 day delay. */
  | "shared-cell"
  /** Counts by county or management unit only. */
  | "aggregate";

export interface DataSharingAgreement {
  id: string;
  /** The org sharing the data. */
  provider_org_id: string;
  /** Orgs allowed to see it. */
  recipient_org_ids: string[];
  /** Which data kinds are covered. */
  data_kinds: Array<"sightings" | "losses" | "collar-cells" | "alerts" | "range-schedules">;
  tier: Exclude<LocationTier, "own-full">;
  /** Shared-cell size in miles (1 to 2). */
  cell_miles?: number;
  /** Delay before shared cells are visible, in hours (48 to 72). */
  delay_hours?: number;
  /** Apply the den-season holdback (see DenSeasonHoldback). */
  den_season_holdback: boolean;
  starts_on: string;
  ends_on?: string;
  signed_by: Array<{ org_id: string; contact_name: string; signed_at: string }>;
  /** Link to the signed document in the org's own records. */
  document_ref?: string;
}

/**
 * During den season, cells inside a holdback area are left out of shared
 * views. They are not drawn and not marked, so a missing cell does not
 * reveal a den.
 */
export interface DenSeasonHoldback {
  id: string;
  /** Agency org that sets the holdback. */
  set_by_org_id: string;
  /** Month-day range, for example "04-01" to "07-15". */
  from_md: string;
  to_md: string;
  /** Opaque reference to the area, held by the agency; no geometry here. */
  area_ref: string;
}

export interface Schedule {
  id: string;
  org_id: string;
  kind: "grazing" | "turnout" | "gather" | "range-rider" | "agency-patrol" | "meeting";
  starts_at: string;
  ends_at: string;
  /** Opaque pasture or allotment reference; no geometry. */
  place_ref?: string;
  visible_to_org_ids: string[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor_user_id: string;
  actor_org_id: string;
  action:
    | "view"
    | "export"
    | "create"
    | "update"
    | "delete"
    | "share"
    | "agreement-sign"
    | "agreement-revoke"
    | "login";
  /** What was touched, for example "agreement:123". */
  target: string;
  /** The agreement that allowed the action, when it was a shared view. */
  agreement_id?: string;
}

export interface ArcGISConnection {
  kind: "arcgis-online" | "arcgis-enterprise";
  /** Portal URL, for example https://www.arcgis.com or the org's Enterprise portal. */
  portal_url: string;
  /** OAuth 2.0 app client id registered by the org. The secret is never stored here. */
  client_id: string;
  /** Layers the org chose to share, by item id. */
  shared_item_ids: string[];
}

/** PastureTrace v1 messages. Must match schemas/integrations/pasturetrace/v1. */
export interface PastureTraceInbound {
  tenant_id: string;
  animal_id: string;
  event_type: "unusual_movement" | "herd_scatter" | "distress" | "mortality" | "device_offline";
  timestamp: string;
  confidence: number;
  source: "pasturetrace";
}

export interface PastureTraceOutbound {
  tenant_id: string;
  alert_level: "info" | "watch" | "warning";
  species: "gray_wolf" | "mexican_wolf" | "grizzly_bear" | "black_bear" | "mountain_lion" | "coyote" | "unknown";
  window_start: string;
  window_end: string;
  reviewed: boolean;
}
