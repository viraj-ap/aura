# Android build toolchain for AURA, in a throwaway container: nothing is installed on the Mac.
# Google ships the Linux SDK/NDK for x86_64 only, so this runs as linux/amd64 (Docker emulates it on Apple Silicon).
FROM --platform=linux/amd64 node:24-bookworm-slim AS node

FROM --platform=linux/amd64 eclipse-temurin:17-jdk-jammy
ARG ACCEPT_ANDROID_LICENSES=no
RUN test "$ACCEPT_ANDROID_LICENSES" = "yes" || (echo "Build with --build-arg ACCEPT_ANDROID_LICENSES=yes to accept the Android SDK licenses." && exit 1)

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip git ca-certificates python3 && rm -rf /var/lib/apt/lists/*
# Gradle runs node (Expo autolinking, React Native codegen) — only the binary is needed.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
 && curl -fsSLo /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip \
 && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/tools.zip
# Versions required by React Native 0.88 / Expo SDK 58 (node_modules/react-native/gradle/libs.versions.toml).
RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006" "cmake;3.22.1" > /dev/null
