// Store app identity, shared by the Worker (Android app links) and the
// Capacitor and Trusted Web Activity configs.
//
// APP_ID is changeable until the first store upload; after that the stores
// tie the listing to it for good. If it changes, also change appId in
// capacitor.config.ts and packageId in docs/app-store/twa/twa-manifest.json
// (test/stage7-app.test.ts checks they match).

export const APP_ID = "org.predatorwatch.app";
export const APP_NAME = "Predator Watch by BitPrairie";
export const APP_SHORT_NAME = "Predator Watch";
export const DEVELOPER_NAME = "BitPrairie";

/**
 * SHA-256 fingerprints of the Android signing certificate, for
 * /.well-known/assetlinks.json (Digital Asset Links). Needed only for the
 * Trusted Web Activity build, so the Play app can open the site full screen.
 *
 * PLACEHOLDER: replace with the "App signing key certificate" SHA-256 from
 * Play Console > Test and release > App integrity (and, if you sideload,
 * your upload key's fingerprint from `keytool -list -v -keystore ...`).
 * A fingerprint is public, not a secret; the signing key itself must never
 * be committed.
 */
export const ANDROID_CERT_FINGERPRINTS: readonly string[] = [
  "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
];
export const PLACEHOLDER_FINGERPRINT = ANDROID_CERT_FINGERPRINTS[0];

export function assetLinks(): unknown[] {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: APP_ID, sha256_cert_fingerprints: [...ANDROID_CERT_FINGERPRINTS] },
    },
  ];
}
