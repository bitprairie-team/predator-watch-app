// iOS and Android apps (Capacitor). The apps bundle the web files from
// dist/native (built by `npm run build:native`) and read live data from the
// public site's API. See docs/app-store/README.md for the build steps.
//
// appId: changeable until the first store upload, then fixed for good. Keep
// it equal to APP_ID in src/config/app.ts (test/stage7-native.test.ts checks).
// Colors: equal to APP_COLORS in src/config/palette.ts (checked by the same
// test); written out here because the Capacitor CLI loads this file alone.
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.predatorwatch.app",
  appName: "Predator Watch by BitPrairie",
  webDir: "dist/native",
  backgroundColor: "#f2ede4",
  ios: {
    contentInset: "never",
    backgroundColor: "#f2ede4",
  },
  android: {
    backgroundColor: "#f2ede4",
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: "#f2ede4",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
    },
  },
};

export default config;
