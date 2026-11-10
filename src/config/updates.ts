// Official, public wolf updates: agency news, reports, population counts and
// status notices. The Worker cron fetches these into KV. Nothing here is
// invented; each item keeps the agency's title, date and link.

export type UpdateKind = "report" | "news" | "status-notice" | "count";

export interface UpdateSourceBase {
  id: string;
  agency: string;
  creditShort: string;
  /** Agency page or API the items come from. */
  url: string;
  license: string;
  /** How often this app checks the source. */
  refreshMinutes: number;
}

export interface FederalRegisterSource extends UpdateSourceBase {
  type: "federal-register";
  /** Full Federal Register API URL, including filters. */
}

export interface HtmlLinksSource extends UpdateSourceBase {
  type: "html-links";
  /** href must match; capturing group 1 is used in the item id when present. */
  hrefRe: string;
  /** Optional: link text must also match. */
  titleRe?: string;
  maxItems?: number;
}

export interface CsvCountSource extends UpdateSourceBase {
  type: "csv-count";
  /** Column name for the year. */
  yearField: string;
  /** Column name for the official count. */
  countField: string;
  /** Skip rows whose count is empty or "N/A". */
  skipEmpty?: boolean;
  factId: string;
  factLabel: string;
}

export interface HtmlCountSource extends UpdateSourceBase {
  type: "html-count";
  /** Must have named groups year/month (optional) and count, and optional packs. */
  factRe: string;
  factId: string;
  factLabel: string;
}

export type UpdateSource = FederalRegisterSource | HtmlLinksSource | CsvCountSource | HtmlCountSource;

const FR =
  "https://www.federalregister.gov/api/v1/documents.json?per_page=40&order=newest" +
  "&fields[]=title&fields[]=publication_date&fields[]=type&fields[]=html_url&fields[]=abstract" +
  "&conditions[agencies][]=fish-and-wildlife-service" +
  "&conditions[term]=%22gray+wolf%22+OR+%22Mexican+wolf%22+OR+%22Canis+lupus%22";

export const UPDATE_SOURCES: UpdateSource[] = [
  {
    type: "federal-register",
    id: "fr-fws-wolf",
    agency: "U.S. Fish and Wildlife Service",
    creditShort: "Federal Register / USFWS",
    url: FR,
    license: "U.S. federal government work; public domain in the U.S.",
    refreshMinutes: 24 * 60,
  },
  {
    type: "html-links",
    id: "wdfw-wolf-updates",
    agency: "Washington Department of Fish and Wildlife",
    creditShort: "WDFW",
    url: "https://wdfw.wa.gov/species-habitats/at-risk/species-recovery/gray-wolf/updates",
    license: "Public WDFW web page; credit WDFW.",
    refreshMinutes: 24 * 60,
    hrefRe: "/species-habitats/at-risk/species-recovery/gray-wolf/updates/([^\"?#]+)",
    maxItems: 20,
  },
  {
    type: "html-links",
    id: "cdfw-wolf-updates",
    agency: "California Department of Fish and Wildlife",
    creditShort: "CDFW",
    url: "https://wildlife.ca.gov/Conservation/Mammals/Gray-Wolf/Updates",
    license: "Published by CDFW for public information under the CDFW Conditions of Use.",
    refreshMinutes: 24 * 60,
    hrefRe: "/Conservation/Mammals/Gray-Wolf/Updates/([A-Za-z0-9][^\"?#/]*)",
    titleRe: "Update|Report",
    maxItems: 16,
  },
  {
    type: "html-links",
    id: "mn-dnr-wolf-surveys",
    agency: "Minnesota Department of Natural Resources",
    creditShort: "Minnesota DNR",
    url: "https://www.dnr.state.mn.us/wolves/index.html",
    license: "Public Minnesota DNR web page; credit Minnesota DNR.",
    refreshMinutes: 7 * 24 * 60,
    hrefRe: "https://files\\.dnr\\.state\\.mn\\.us/wildlife/wolves/([^\"?#]+\\.pdf)",
    titleRe: "Wolf Population Survey",
    maxItems: 8,
  },
  {
    type: "html-links",
    id: "wi-dnr-wolf-reports",
    agency: "Wisconsin Department of Natural Resources",
    creditShort: "Wisconsin DNR",
    url: "https://dnr.wisconsin.gov/topic/WildlifeHabitat/wolf",
    license: "Public Wisconsin DNR web page; credit Wisconsin DNR.",
    refreshMinutes: 7 * 24 * 60,
    hrefRe: "https://widnr\\.widen\\.net/s/[^\"?#]+/(wolf[^\"]*)",
    titleRe: "Wolf Monitoring Report",
    maxItems: 8,
  },
  {
    type: "html-links",
    id: "odfw-wolf-reports",
    agency: "Oregon Department of Fish and Wildlife",
    creditShort: "ODFW",
    url: "https://dfw.state.or.us/Wolves/population.html",
    license: "Public ODFW web page; credit ODFW. Data may be distributed if the metadata file accompanies the data.",
    refreshMinutes: 7 * 24 * 60,
    hrefRe: "https://(?:www\\.)?dfw\\.state\\.or\\.us/Wolves/docs/[^\"?#]+\\.pdf",
    titleRe: "Annual Wolf (Conservation and )?Management|Wolf Report",
    maxItems: 6,
  },
  {
    type: "html-count",
    id: "odfw-minimum-count",
    agency: "Oregon Department of Fish and Wildlife",
    creditShort: "ODFW",
    url: "https://dfw.state.or.us/Wolves/population.html",
    license: "Public ODFW web page; credit ODFW.",
    refreshMinutes: 7 * 24 * 60,
    // The official table's last calendar-year row, as written by ODFW.
    factRe: String.raw`(?<year>20\d{2})\*?\s+(?<count>\d{2,4})\s+\d+`,
    factId: "odfw-minimum-count",
    factLabel: "Minimum wolf count",
  },
  {
    type: "html-count",
    id: "nps-yellowstone-count",
    agency: "National Park Service",
    creditShort: "NPS",
    url: "https://www.nps.gov/yell/learn/management/wolf.htm",
    license: "U.S. federal government work; public domain in the U.S.",
    refreshMinutes: 7 * 24 * 60,
    factRe: String.raw`As of (?<month>[A-Za-z]+)\s+(?<year>20\d{2}), there were at least (?<count>\d{1,4}) wolves in the park.`,
    factId: "nps-yellowstone-count",
    factLabel: "Yellowstone Wolf Project minimum count",
  },
  {
    type: "csv-count",
    id: "nps-isro-count",
    agency: "National Park Service",
    creditShort: "NPS",
    url: "https://www.nps.gov/common/uploads/sortable_dataset/isro/0E4BCABF-0DB5-C4A8-4E116EF63B3EDCF4/isro-WolfMoosePopulationsfrom1980Updatedthru20261.csv",
    license: "U.S. federal government work; public domain in the U.S.",
    refreshMinutes: 7 * 24 * 60,
    yearField: "Year",
    countField: "Number of Wolves",
    skipEmpty: true,
    factId: "nps-isro-count",
    factLabel: "Isle Royale wolf count",
  },
];
