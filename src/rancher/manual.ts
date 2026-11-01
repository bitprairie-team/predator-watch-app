// Manual parity. Everything an agent does, the rancher can do by hand in the
// Ranch tools page, with the assistant and every agent off. This map is the
// contract: each agent job lists the routes that do the same work by hand and
// the label of the control in public/ranch.js. Tests check that every route
// works with everything off, that every tool an agent may read has a by-hand
// view, and that the page has a control for each one.
export interface ManualPath {
  /** What the rancher gets, in plain words. */
  job: string;
  method: "GET" | "POST" | "PUT";
  /** Route under /api/ranch. ":tool" style placeholders are filled by the page. */
  path: string;
  /** The control's label on the Ranch tools page. */
  ui: string;
}

export const MANUAL_PATHS: Record<string, ManualPath[]> = {
  morning_digest: [
    { job: "Build today's digest by hand", method: "POST", path: "/api/ranch/manual/morning_digest", ui: "Build digest" },
    { job: "View allotment activity", method: "POST", path: "/api/ranch/data/allotment_wolf_activity", ui: "Show allotment activity" },
    { job: "View fire and weather alerts", method: "POST", path: "/api/ranch/data/fire_weather_alerts", ui: "Show alerts" },
    { job: "See when each data layer was last received", method: "POST", path: "/api/ranch/data/data_freshness", ui: "Show data freshness" },
    { job: "Export allotment activity", method: "GET", path: "/api/ranch/export/allotment-activity.csv", ui: "Export allotment activity" },
  ],
  new_report_alert: [
    { job: "Check for reports near your ranches now", method: "POST", path: "/api/ranch/manual/new_report_alert", ui: "Check now" },
    { job: "View reports near a ranch", method: "POST", path: "/api/ranch/data/recent_predator_activity", ui: "Show nearby reports" },
    { job: "View allotment activity", method: "POST", path: "/api/ranch/data/allotment_wolf_activity", ui: "Show allotment activity" },
    { job: "Set alert areas and distance", method: "PUT", path: "/api/ranch/settings/agents/new_report_alert", ui: "Save alert areas" },
    { job: "Export nearby reports", method: "GET", path: "/api/ranch/export/nearby-activity.csv", ui: "Export nearby reports" },
  ],
  meeting_prep: [
    { job: "Build a meeting prep packet by hand", method: "POST", path: "/api/ranch/manual/meeting_prep", ui: "Build packet" },
    { job: "Download the packet as text", method: "POST", path: "/api/ranch/manual/meeting_prep?format=txt", ui: "Download packet" },
    { job: "See agency contacts and how to report", method: "POST", path: "/api/ranch/data/agency_contacts_and_reporting", ui: "Show contacts" },
    { job: "View reports near a ranch", method: "POST", path: "/api/ranch/data/recent_predator_activity", ui: "Show nearby reports" },
    { job: "View allotment activity", method: "POST", path: "/api/ranch/data/allotment_wolf_activity", ui: "Show allotment activity" },
    { job: "See when each data layer was last received", method: "POST", path: "/api/ranch/data/data_freshness", ui: "Show data freshness" },
    { job: "Export your own records", method: "GET", path: "/api/ranch/export/records.csv", ui: "Export your records" },
  ],
};

/** Things the assistant can look up, each with its by-hand view. No tool is reachable only through the assistant. */
export const MANUAL_TOOL_VIEWS: Record<string, string> = {
  recent_predator_activity: "Show nearby reports",
  allotment_wolf_activity: "Show allotment activity",
  fire_weather_alerts: "Show alerts",
  agency_contacts_and_reporting: "Show contacts",
  data_freshness: "Show data freshness",
  nonlethal_deterrents: "Find guides",
  weekly_summary: "Show weekly summary",
  my_audit_log: "Show access log",
};
