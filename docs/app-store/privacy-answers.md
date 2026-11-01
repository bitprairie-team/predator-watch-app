# Privacy answers for the stores

Based on the code on this branch (checked October 31, 2026). Re-check if any
of these change: `public/search.js` and `src/api/geocode.ts` (address
search), `public/app.js` (location, tap lookups, share link), `public/net.js`
and `public/sw.js` (saved copies), `wrangler.jsonc` (logs). The public policy
is `public/privacy.html`, served at https://app.predatorwatch.org/privacy.

## What the code does

| Data | Leaves the device? | Where it goes | Kept |
|---|---|---|---|
| Device location (only after the user taps locate) | No | Used in the page to center the map and draw a dot | Not stored |
| Map area being viewed | Yes, as tile requests | Basemap and agency tile servers, as with any map | Their own logs |
| Town, county, ZIP typed in search | No | Matched on the device against downloaded Census Gazetteer files (one file per first letter) | Not stored |
| Street address typed in search | Yes | Our API, then the U.S. Census Bureau Geocoder | Our edge cache keeps the answer up to 7 days, keyed by the address text only, and the device may keep it a day; Cloudflare request logs (short-lived) include the request URL |
| Point tapped on an agency map layer | Yes | That agency's public map service (land manager lookup) | Their own logs |
| Settings (theme, view, text size, contrast, open panels) | No | Browser/app storage on the device | Until the user clears it |
| Saved copies of agency data | No | Cache storage on the device | Until replaced or cleared |
| IP address, user agent | Yes (every request) | Cloudflare, to deliver and protect the site, rate limit per visitor | Short-lived logs |
| Accounts, names, emails, phone numbers, contacts, photos, payments | Not collected | | |
| Analytics, ads, crash reporting, tracking SDKs | None in the code | | |

## Apple App Store: App Privacy ("nutrition label")

Recommended answers (the cautious reading, which matches the privacy page):

1. **Do you or your third-party partners collect data from this app?** Yes.
2. **Data types collected:**
   - **Search History** (street addresses typed into search).
     - Used for: **App Functionality**.
     - Linked to the user's identity: **No**.
     - Used for tracking: **No**.
3. Nothing else. Do **not** select Location: the position never leaves the
   device. Do not select Identifiers, Usage Data, Diagnostics, Contact Info
   or User Content.
4. **Tracking (App Tracking Transparency):** No tracking; no ATT prompt needed.

Resulting label: "Data Not Linked to You: Search History". No "Data Used to
Track You", no "Data Linked to You".

Alternative (owner's call): Apple's "optional disclosure" exemption may let
you answer "Data Not Collected", since address search is optional,
infrequent and not linked to anyone. The cautious answer above is
recommended because the address text sits in a cache for up to 7 days.

Other App Store Connect answers:
- **Uses encryption:** only standard HTTPS. `ITSAppUsesNonExemptEncryption`
  is set to false in `ios/App/App/Info.plist`, so no export compliance
  documents are needed.
- **Sign in with Apple:** not applicable (no accounts).
- **Account deletion:** not applicable (no accounts).

## Google Play: Data safety

1. **Does your app collect or share any of the required user data types?** Yes.
2. **Is all of the user data collected by your app encrypted in transit?** Yes (HTTPS only; `allowMixedContent` is false).
3. **Do you provide a way for users to request that their data is deleted?**
   No. Nothing is tied to a person; cached address answers expire on their
   own within 7 days. (If Play insists, point to the contact page; there is
   no account to delete.)
4. **Data types:**
   - **App activity > In-app search history: Collected.**
     - Shared: **No** (sending the address to the Census Bureau Geocoder is
       a user-initiated request the user expects; Play's sharing exemption
       for user-initiated transfers applies).
     - Processed ephemerally: **No** (cached up to 7 days).
     - Required or optional: **Optional** (search works without addresses, and the map works without search).
     - Purpose: **App functionality**.
   - **Location (approximate and precise): Not collected.** The app asks for
     location permission, but the position is used only on the device. Play
     counts data as collected only when it leaves the device.
   - Everything else: **Not collected.**
5. **Families / children:** target audience 18+ or "general audience, not
   designed for children"; the app has no ads.

Play also asks about the location permission in the **App content >
Sensitive permissions** form only for background location; this app asks for
foreground location only (`ACCESS_COARSE_LOCATION`,
`ACCESS_FINE_LOCATION`), so that form does not apply.

## If you ship the Trusted Web Activity instead

The answers are the same. A TWA runs the website in Chrome, so Chrome's own
data handling also applies; Play's form covers only your app's code.
