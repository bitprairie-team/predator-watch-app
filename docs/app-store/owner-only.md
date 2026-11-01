# Owner-only steps

These need the owner's accounts, money or keys. Nothing here is in the repo,
and no key or password should ever be committed (`.gitignore` blocks
`*.jks`, `*.keystore`, `*.p12`, `*.p8`, `*.mobileprovision`, `*.pem`, `*.key`
and `key.properties`; `test/stage7-native.test.ts` fails if one appears).

| Step | Cost | Where |
|---|---|---|
| Apple Developer Program, enrolled as BitPrairie (an organization needs a D-U-N-S number) | $99 per year | developer.apple.com/programs |
| Google Play developer account as BitPrairie (identity and, for an organization, D-U-N-S verification) | $25 one time | play.google.com/console |
| Pick and keep the final app id (default org.predatorwatch.app) | | src/config/app.ts, capacitor.config.ts, twa/twa-manifest.json |
| iOS signing: let Xcode manage the certificate and profile for your team | included | Xcode > Signing & Capabilities |
| Android upload key: create with `keytool` (README), store it and its passwords in a password manager with a backup | | outside the repo |
| Play App Signing: accept Google-managed app signing on first upload | | Play Console > App integrity |
| TWA only: copy the app signing SHA-256 into `ANDROID_CERT_FINGERPRINTS` and deploy | | src/config/app.ts |
| A monitored support email for the listings and review contact | | listing.md placeholders |
| Read and approve the privacy policy text (it states facts about the code; legal review is the owner's call) | | public/privacy.html |
| Merge, deploy the site, and press Submit in each store | | |

Decisions left to the owner
- Home screen label: the app name is the full "Predator Watch by
  BitPrairie", which iOS and Android shorten under the icon (for example
  "Predator Watc…"). To show "Predator Watch" under the icon while the store
  keeps the full name, set `CFBundleDisplayName` in `ios/App/App/Info.plist`
  and `app_name` in `android/app/src/main/res/values/strings.xml` to
  "Predator Watch" (and update the test that checks them).
- Apple privacy label: the cautious "Search History, not linked" answer, or
  "Data Not Collected" under Apple's optional-disclosure rule
  (privacy-answers.md).
- Capacitor or TWA for Google Play (README).
