# FarmOS Mobile

React Native CLI client for FarmOS field operations. It uses the same FarmOS REST endpoints, realtime events, and server-side `ADMIN` / `USER` authorization as the web dashboard.

## Security model

- The user selects **Continue with Google**. Supabase runs the Google OAuth flow in the system browser, receives the Google identity result, and the app exchanges its short-lived Supabase token at `POST /api/v1/auth/mobile/session`.
- FarmOS returns a separate mobile JWT audience. It is stored in iOS Keychain / Android Keystore with `react-native-keychain`.
- Every API request sends `Authorization: Bearer <mobile-token>`; Socket.IO sends that token in its handshake.
- The backend loads role and Farm membership from its database. Hiding an admin tab in the app is not treated as an authorization boundary.
- Never put an MQTT password, a Supabase service-role key, or backend JWT secret into this project.

## Configure

The single source is the repository-root `.env`. Before a mobile build,
`npm run prepare:config` reads only the public URL, Supabase, and temporary
URL-alias variables:

```text
FARMOS_API_URL=https://api.example.com
FARMOS_WEB_URL=https://app.example.com
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<public-anon-key>
```

`DOMAIN`, `CORS_ORIGIN`, `MOBILE_API_BASE_URL`, and `BACKEND_API_URL` remain
temporary migration aliases; they are normalized to canonical origins and
never emitted to the generated app config. Legacy API aliases may contain
`/api/v1/...`.

## CI/CD

Every pull request and push to `main` runs mobile TypeScript checks and Jest.
Native Android APK/AAB builds run locally or in a dedicated release workflow,
not on the normal backend/web deployment path.

Before enabling the mobile CI job, configure these GitHub **Actions variables**
(they are public client configuration, never service-role/JWT/DB secrets):

```text
FARMOS_API_URL=https://api.example.com
FARMOS_WEB_URL=https://app.example.com
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<public-anon-key>
```

For a signed Play release, retain the existing `mobile/android/keystore.properties`
contract and use a separate approval-gated publishing workflow with the upload
keystore supplied as a GitHub secret. Do not add that keystore to Git.

`FARMOS_API_URL` and `FARMOS_WEB_URL` must be URL origins. Do not put
`/api/v1/telemetry` or another route in either value; the mobile API client
adds its versioned API path itself. The script writes an ignored generated
file containing only this allowlist and a source hash over those public
values. It never parses or hashes server secrets. Missing, stale, malformed,
or route-based configuration fails the build with the variable name.

`SUPABASE_SERVICE_ROLE_KEY`, database URLs, JWT secrets, firmware signing
keys, and MQTT credentials are never copied to the app.

In Supabase Auth, enable Google and add this redirect URL exactly:

```text
farmos://auth/callback
```

The Android/iOS deep-link handlers are already registered. Google client/provider setup remains in Supabase; no Google secret is embedded in the React Native project.

## Run

```sh
cd /Users/levanduy/FarmOS/mobile
npm install
npm run prepare:config:check
npm start
npm run android
```

For iOS, install CocoaPods once after dependencies change:

```sh
cd /Users/levanduy/FarmOS/mobile/ios
bundle install
bundle exec pod install
cd ..
npm run ios
```

## Current mobile scope

- Login and secure session recovery
- Farm/zone dashboard, alerts, realtime Socket.IO refresh
- Manual irrigation and emergency stop through the existing Safety Engine
- Alert resolution, irrigation ACK/status history, and device details/management
- Admin-only user list with role changes and guarded account deletion; a `USER` sees only Farms authorized by backend membership checks

## Release builds

The commands below separate compilation checks from distributable, signed artifacts. Android Gradle and the iOS Xcode target both run the public-config generator before compiling/bundling, so a direct debug, release, run, or archive build cannot silently use a stale generated file. Do not put a keystore, password, Apple certificate, provisioning profile, or signing secret in Git.

### Android

From `mobile/android`:

```sh
# Debug APK; signed with the local Android debug key for development only.
./gradlew app:assembleDebug

# Release compile checks; unsigned when keystore.properties is absent.
./gradlew app:assembleRelease app:bundleRelease
./gradlew app:signingReport
```

Without `keystore.properties` in `mobile/android`, the expected release outputs are:

```text
app/build/outputs/apk/release/app-release-unsigned.apk
app/build/outputs/bundle/release/app-release.aab
```

`release` must show `Config: null` in `signingReport`; it must never fall back to the debug certificate. An unsigned APK/AAB is a compile artifact and is not ready for a device release or Play Store upload.

For a real release, from `mobile/android`, copy `keystore.properties.example` to `keystore.properties`, replace every placeholder with the release/upload keystore values, then run:

```sh
./gradlew app:assembleRelease app:bundleRelease
```

Verify the APK/AAB signature before distribution:

```sh
$ANDROID_HOME/build-tools/<version>/apksigner verify --verbose app/build/outputs/apk/release/app-release.apk
jarsigner -verify -verbose -certs app/build/outputs/bundle/release/app-release.aab
```

For an unsigned local build, `apksigner` must fail and `jarsigner` reports `jar is unsigned`; after supplying a real keystore, both commands must show a verified signature before distribution.

The Play Console upload key and the app signing key are part of the production release process and must be managed outside this repository.

### iOS

Install/update CocoaPods after native dependency changes:

```sh
cd mobile/ios
bundle exec pod install
```

This React Native 0.87 project intentionally builds React Native Core,
React Native dependencies, and Hermes from one source graph so
`react-native-screens` links consistently on both simulator and device
architectures. Install CMake (`brew install cmake`) before the first pod
install. The first iOS build is slower because it compiles Hermes; subsequent
builds reuse Xcode's derived data.

Use the actual Xcode developer directory explicitly when `xcode-select` points to Command Line Tools:

```sh
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer

# Compile-only simulator check; this does not sign an App Store artifact.
xcodebuild -workspace FarmOSMobile.xcworkspace \
  -scheme FarmOSMobile -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/farmos-mobile-ios-debug \
  CODE_SIGNING_ALLOWED=NO build

# Compile-only device-architecture check; this is not installable or distributable.
xcodebuild -workspace FarmOSMobile.xcworkspace \
  -scheme FarmOSMobile -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/farmos-mobile-ios-release \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

The resulting `.app` is unsigned. A real iOS release requires an Apple Developer Team, Bundle Identifier, distribution certificate, provisioning profile, and an Xcode `Archive`/`Export` step with signing enabled. A successful compile alone does not prove that the app can be installed on a physical iPhone or uploaded to App Store Connect.

Before archiving, confirm that every declared App Icon PNG has the expected pixel dimensions and no alpha channel:

```sh
cd mobile
for icon in ios/FarmOSMobile/Images.xcassets/AppIcon.appiconset/*.png; do
  sips -g pixelWidth -g pixelHeight -g hasAlpha "$icon"
done
```

Bluetooth, camera, local-networking, and privacy-manifest entries are part of the checked-in iOS metadata; permissions still need verification on a real iPhone because Simulator cannot validate BLE or camera behavior.

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
