// Tenant data model for the private rancher plan. Stored in the private KV
// namespace under keys owned by the data access layer (see data.ts).
import type { AgentSettings } from "./background-agents";
import type { Geometry } from "../schema";
import type { Plan } from "../agents/types";

export interface TenantRecord {
  id: string;
  name: string;
  plan: Plan;
  billing_active?: boolean;
  /** Sharing groups this tenant reads generalized shared reports from. */
  sharing_groups: string[];
  ranches: Ranch[];
  contacts: Contact[];
  reporting: ReportingProcess[];
  /** Background agent settings, by agent id. Off unless set. */
  agents?: Record<string, AgentSettings>;
  updated_at: string;
}

export interface Ranch {
  id: string;
  name: string;
  location: { lat: number; lon: number };
  allotments: Allotment[];
}

export interface Allotment {
  id: string;
  name: string;
  managing_agency: string;
  /** The agency's own allotment number, when known. */
  agency_allotment_id?: string;
  geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;
  /** Where the boundary came from (for example the agency allotment layer). */
  geometry_source: { publisher: string; url: string | null; received_at: string };
}

export interface ProvenanceRef {
  publisher: string;
  url: string | null;
  /** When someone last confirmed this entry against the publisher. */
  verified_at: string;
}

export interface Contact {
  role: string;
  name: string;
  organization: string;
  phone?: string;
  email?: string;
  url?: string;
  notes?: string;
  source: ProvenanceRef;
}

export interface ReportingProcess {
  topic: "depredation" | "sighting" | "general";
  title: string;
  steps: string[];
  source: ProvenanceRef;
}

/** A tenant's own record. Shown to that tenant at full precision. */
export interface Observation {
  id: string;
  ranch_id?: string;
  species: string;
  kind: "sighting" | "sign" | "depredation" | "camera" | "other";
  lat: number;
  lon: number;
  observed_at: string;
  received_at: string;
  notes?: string;
  /** Owner chose to contribute this record to their sharing groups. */
  share: boolean;
  /** Den or rendezvous site flag. Never shared. */
  sensitive?: "den";
}

/** A shared copy of an observation. Carries no tenant id or notes. */
export interface SharedObservation {
  id: string;
  group: string;
  /** Hash of the contributing tenant, used only to drop a tenant's own copies. */
  origin: string;
  species: string;
  kind: Observation["kind"];
  lat: number;
  lon: number;
  observed_at: string;
  received_at: string;
  sensitive?: "den";
}

/**
 * One rancher's place in a sharing group, as set by the signed data-sharing
 * agreement. Only active, unexpired members can read the group, and only
 * their reports made while they were members are shared.
 */
export interface GroupMember {
  /** originHash(tenant id), never the tenant id itself. */
  origin: string;
  status: "active" | "suspended" | "left";
  joined_at: string;
  /** When the membership ends (left, or the agreement term ends). */
  ends_at?: string | null;
  /** Defaults to true. */
  can_read?: boolean;
  /** Defaults to true. */
  can_contribute?: boolean;
}

export interface SharingAgreement {
  id: string;
  version: string;
  signed_at: string;
  expires_at?: string | null;
}

export interface SharingGroupPolicy {
  id: string;
  name: string;
  /** The data-sharing agreement. With none on file, nothing is shared. */
  agreement?: SharingAgreement;
  /** Who may read and contribute. With no list on file, nothing is shared. */
  members?: GroupMember[];
  /** Cell size for shared data, 1 to 2 miles. */
  cell_miles: number;
  /** Delay before shared data is visible, 48 to 72 hours. */
  delay_hours: number;
  /** Den season window as MM-DD dates; may wrap the new year. */
  den_season?: { start: string; end: string };
  /** Cells hidden during den season, set by the group's agency partners. */
  holdback_cells?: string[];
}

/** A stored reference document (agency or extension publication). */
export interface ReferenceDocument {
  id: string;
  title: string;
  publisher: string;
  url: string;
  published_at: string | null;
  retrieved_at: string;
  topics: string[];
  /** Short passages quoted or closely summarized from the document. */
  excerpts: string[];
}
