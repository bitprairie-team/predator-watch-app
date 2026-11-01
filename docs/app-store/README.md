# App store kit

Everything needed to put Predator Watch in the Apple App Store and Google
Play, plus the steps only the owner can do.

| File | What it is |
|---|---|
| [listing.md](listing.md) | Name, subtitle, descriptions, keywords, review notes |
| [privacy-answers.md](privacy-answers.md) | App Store privacy label and Play Data safety answers, from the code |
| [content-rating.md](content-rating.md) | Age rating questionnaires |
| [owner-only.md](owner-only.md) | Accounts, fees, signing keys and the final submit |
| [screenshots/](screenshots/) | Store screenshots (made by `npm run store:shots`) |
| [twa/twa-manifest.json](twa/twa-manifest.json) | Config for the Google Play Trusted Web Activity option |

Names: the store name is **Predator Watch by BitPrairie**, the seller is
**BitPrairie**, the app id is **org.predatorwatch.app** (changeable until the
first upload; after that the stores fix it for good). The id and name live
in `src/config/app.ts`, `capacitor.config.ts` and `twa/twa-manifest.json`;
`test/stage7-native.test.ts` fails if they drift apart.

## How the apps work

- **Website (installable):** app.predatorwatch.org has a full web app
  manifest and a service worker, so browsers offer "Install" / "Add to Home
  Screen". Nothing to submit.
- **iOS and Android apps (Capacitor):** `ios/` and `android/` load the web
  files bundled in the app (`dist/native`, built by `npm run build:native`)
  and read live data from `https://app.predatorwatch.org/api`. Saved copies
  for offline use are kept on the device and always shown with their time.
- **Google Play, second option (Trusted Web Activity):** a thin Android app
  that opens app.predatorwatch.org full screen in Chrome. Smaller, always the
  live site, but needs `/.well-known/assetlinks.json` to carry the real
  signing fingerprint (see owner-only.md). Use **either** the Capacitor
  Android app **or** the TWA for Play, not both: they share the same app id.

Recommendation: Capacitor for both stores (works offline from first launch,
and Apple does not accept a plain website wrapper). The TWA is there if you
would rather Play always run the live site.

## Screenshots

`npm run dev`, then `npm run store:shots` (needs Playwright: `npm i -g
playwright && npx playwright install chromium`). It writes:

| Folder | Pixels | Store slot |
|---|---|---|
| screenshots/ios-6.7in | 1290 x 2796 | iPhone 6.9"/6.7" (required) |
| screenshots/ios-6.5in | 1284 x 2778 | iPhone 6.5" |
| screenshots/ios-ipad-12.9in | 2048 x 2732 | iPad 13"/12.9" (required if iPad is supported) |
| screenshots/play-phone | 1080 x 1920 | Play phone |
| screenshots/play-tablet-7in | 1200 x 1920 | Play 7" tablet |
| screenshots/play-tablet-10in | 1600 x 2560 | Play 10" tablet |

It also refreshes `public/icons/screenshot-narrow.png` and
`screenshot-wide.png`, used by the browser install dialog. For production
data in the shots, run it with `BASE=https://app.predatorwatch.org`.

The Play feature graphic (1024 x 500) is not generated; use `public/og.png`
resized, or make one from the brand files in `public/brand/`.

## Build on a Mac: exact commands

Needs: macOS with **Xcode 26+** (and its command line tools), **Node 22+**,
**Android Studio 2025.2.1+** (it brings JDK 21 and the Android SDK; install
SDK Platform 36 in Tools > SDK Manager).

```bash
git clone https://github.com/steelhead99x/predator-watch-app.git
cd predator-watch-app
git checkout feat/stage7-mobile        # or main, once merged
npm ci                                 # also copies MapLibre into public/vendor
npm test                               # all tests should pass
npm run build:native                   # web files for the apps -> dist/native
npx cap sync                           # copies them into ios/ and android/
```

### iOS

```bash
npx cap open ios                       # opens ios/App/App.xcodeproj in Xcode
```

In Xcode: select the **App** target > **Signing & Capabilities** > Team:
your Apple Developer team (bundle id `org.predatorwatch.app`). Run on a
device or simulator once to check location and offline. Then **Product >
Archive** > **Distribute App** > **App Store Connect** > Upload.

The same from the terminal (after setting the team once in Xcode, or pass
`DEVELOPMENT_TEAM=XXXXXXXXXX`):

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/PredatorWatch.xcarchive \
  -allowProvisioningUpdates archive
cat > build/ExportOptions.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath build/PredatorWatch.xcarchive \
  -exportOptionsPlist build/ExportOptions.plist -exportPath build/ios \
  -allowProvisioningUpdates
```

`destination: upload` sends the build to App Store Connect (signed in
through Xcode > Settings > Accounts). Then pick the build in App Store
Connect and submit for review.

### Android (Capacitor)

```bash
# One time: create the upload key (keep it and its passwords outside the repo)
keytool -genkeypair -v -keystore ~/keys/predator-watch-upload.jks \
  -alias upload -keyalg RSA -keysize 2048 -validity 10000

npx cap open android                   # Android Studio: run on a device to test
cd android
./gradlew bundleRelease                # unsigned AAB in app/build/outputs/bundle/release/
jarsigner -keystore ~/keys/predator-watch-upload.jks \
  app/build/outputs/bundle/release/app-release.aab upload
cd ..
```

Or in Android Studio: **Build > Generate Signed App Bundle** > Android App
Bundle > the upload key. Upload the `.aab` in Play Console > Test and
release > (Internal testing first) > Create release. Use **Play App
Signing** (the default): Google keeps the app signing key, you keep only the
upload key.

### Android (Trusted Web Activity option, instead of Capacitor)

```bash
npm i -g @bubblewrap/cli
mkdir -p ~/pw-twa && cd ~/pw-twa
cp /path/to/predator-watch-app/docs/app-store/twa/twa-manifest.json .
bubblewrap update --manifest ./twa-manifest.json   # writes the Android project
bubblewrap build                                   # asks for the keystore; makes app-release-bundle.aab
bubblewrap fingerprint add <SHA-256 from Play Console > App integrity>
```

Then put that SHA-256 in `ANDROID_CERT_FINGERPRINTS` in
`src/config/app.ts`, run `npm test`, and deploy, so
https://app.predatorwatch.org/.well-known/assetlinks.json lists it. Without
it the app shows a browser address bar.

## What was built on Linux (this branch) and what was not

Built and checked here: the installable website, the service worker and
offline page, `/privacy`, `/.well-known/assetlinks.json` (placeholder
fingerprint), the Capacitor `ios/` and `android/` projects with icons,
launch screens and location permission text, the native web bundle, the TWA
config, store copy, privacy answers and screenshots.

Not built here (needs a Mac or Android Studio, and the owner's accounts):
compiling and signing the iOS app, the Android `.aab`, and any upload.

## Submission checklist

Before either store
- [ ] Merge this branch and deploy the site (owner). Check https://app.predatorwatch.org/privacy loads.
- [ ] Decide the final app id (default `org.predatorwatch.app`). Change it now or never.
- [ ] `npm ci && npm test && npm run build:native && npx cap sync` on the Mac.
- [ ] Try the app on a real phone: map loads, locate asks permission with the plain text, airplane mode shows "Saved copy" with a time, links open in the browser.

Apple App Store
- [ ] Apple Developer Program membership, $99/year (owner).
- [ ] App Store Connect > Apps > New App: iOS, name "Predator Watch by BitPrairie", bundle id org.predatorwatch.app, SKU `predator-watch-1`.
- [ ] Paste listing.md fields; upload screenshots from `screenshots/ios-6.7in` (and `ios-6.5in`, `ios-ipad-12.9in`).
- [ ] App Privacy: answers from privacy-answers.md. Privacy Policy URL: https://app.predatorwatch.org/privacy.
- [ ] Age rating from content-rating.md (4+).
- [ ] Pricing: Free. Availability: as the owner chooses.
- [ ] Archive and upload from Xcode; select the build; add review notes from listing.md.
- [ ] Submit for review (owner).

Google Play
- [ ] Google Play Console developer account, $25 one time, identity verification (owner).
- [ ] Create app: name "Predator Watch by BitPrairie", app, free.
- [ ] Main store listing from listing.md; screenshots from `play-phone`, `play-tablet-7in`, `play-tablet-10in`; 512 x 512 icon: `assets/icon-only.png` resized (for example `sips -Z 512 assets/icon-only.png --out build/play-icon.png`); feature graphic 1024 x 500.
- [ ] App content: privacy policy URL, ads (none), app access (no login), content rating (IARC, content-rating.md), target audience, Data safety (privacy-answers.md).
- [ ] Upload the signed `.aab` to Internal testing; new personal developer accounts must run a closed test (12 testers for 14 days) before production.
- [ ] If using the TWA: add the Play App Signing SHA-256 to `src/config/app.ts`, deploy, confirm assetlinks.json.
- [ ] Promote to production and submit (owner).
