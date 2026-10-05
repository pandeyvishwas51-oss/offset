#!/bin/sh
# Builds OffsetDemo.app next to this script. Needs the Xcode command line tools.
set -e
cd "$(dirname "$0")"
APP=build/OffsetDemo.app
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
swiftc -O main.swift -o "$APP/Contents/MacOS/OffsetDemo" -framework Cocoa -framework WebKit
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.offset.demoshell</string>
  <key>CFBundleName</key><string>OFFSET Demo</string>
  <key>CFBundleExecutable</key><string>OffsetDemo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
echo "built $APP"
