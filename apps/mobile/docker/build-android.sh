#!/usr/bin/env bash
# Build AURA's Android development app inside Docker and install it on a USB-connected phone.
#   apps/mobile/docker/build-android.sh            build + install
#   apps/mobile/docker/build-android.sh --clean    remove the image and caches (frees all the space)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$REPO/apps/mobile"
IMAGE=aura-android-builder

if [[ "${1:-}" == "--clean" ]]; then
  docker rmi -f "$IMAGE" || true
  docker volume rm -f aura-gradle-cache aura-android-sdk || true
  echo "Removed the build image and its caches."
  exit 0
fi

docker info > /dev/null 2>&1 || { echo "Docker isn't running — open Docker Desktop first."; exit 1; }

# Native project (android/) is generated from app.json by Expo (CNG); regenerate if missing.
[[ -d "$APP/android" ]] || (cd "$APP" && npx expo prebuild --platform android --no-install)
# Drop leftovers from builds on the Mac (they reference Mac paths/SDKs).
rm -rf "$APP/android/app/build" "$APP/android/app/.cxx" "$APP/android/build" "$APP/android/local.properties"

echo "Building the toolchain image (first time only, ~4 GB)…"
docker build --platform linux/amd64 --build-arg ACCEPT_ANDROID_LICENSES=yes -t "$IMAGE" "$APP/docker"

echo "Building the APK (first build is slow under emulation; later builds reuse the Gradle cache)…"
# The repo is mounted at the same path as on the Mac so Gradle/CMake paths match.
docker run --rm --platform linux/amd64 \
  -v "$REPO:$REPO" -v aura-gradle-cache:/root/.gradle -v aura-android-sdk:/opt/android-sdk \
  -w "$APP/android" -e GRADLE_OPTS="-Dorg.gradle.daemon=false" \
  "$IMAGE" ./gradlew app:assembleDebug -x lint -x test -PreactNativeArchitectures=arm64-v8a

APK="$APP/android/app/build/outputs/apk/debug/app-debug.apk"
echo "Built $APK"
if adb get-state > /dev/null 2>&1; then
  adb install -r "$APK"
  adb reverse tcp:8081 tcp:8081   # lets the app reach the dev server over USB
  echo "Installed. Now run:  cd apps/mobile && npx expo start --dev-client   and open AURA on the phone."
else
  echo "No phone connected over USB. Connect it (USB debugging on) and run:  adb install -r \"$APK\""
fi
