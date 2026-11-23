#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
source_dir="$PWD"
version=45.4.1
case "$(uname -sm)" in
  'Darwin arm64') arch=arm64; digest=d080c3b05a01bd16137f2c12ab9ebf083c577757fe846844ba325bafa8e8bdf4 ;;
  'Darwin x86_64') arch=x64; digest=1c80d2ccf71b02c8fd9940fd09cafe88090a48c1bab0193c79b597b08d890e79 ;;
  *) echo 'Установщик предназначен для Mac.'; exit 1 ;;
esac
read -r major minor rest <<< "$(sw_vers -productVersion | tr '.' ' ')"
if (( major < 14 || (major == 14 && minor < 2) )); then
  echo 'Для записи системного звука нужна macOS 14.2 или новее.'; exit 1
fi
target_dir="$HOME/Applications"
target="$target_dir/Sonat.app"
if [[ -d "$target" && "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$target/Contents/Info.plist" 2>/dev/null || true)" != "0.4.0" ]]; then
  target="$target_dir/Sonat 0.4.0.app"
fi
if [[ -e "$target" ]]; then
  echo "Sonat уже находится в $target"
  if [[ "${1:-}" != "--no-open" ]]; then open -R "$target"; fi
  exit 0
fi
mkdir -p "$target_dir"
stage="$(mktemp -d "$target_dir/.sonat-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
archive="electron-v$version-darwin-$arch.zip"
echo 'Загружается среда приложения с GitHub Electron…'
curl --fail --show-error --location --retry 2 --proto '=https' --proto-redir '=https' \
  "https://github.com/electron/electron/releases/download/v$version/$archive" -o "$stage/$archive"
(cd "$stage" && echo "$digest  $archive" | shasum -a 256 -c -)
ditto -x -k "$stage/$archive" "$stage/runtime"
bundle="$stage/runtime/Electron.app"
plist="$bundle/Contents/Info.plist"
set_string() {
  /usr/bin/plutil -replace "$1" -string "$2" "$plist" 2>/dev/null || /usr/bin/plutil -insert "$1" -string "$2" "$plist"
}
set_string CFBundleIdentifier com.stepancyberpsy.sonat
set_string CFBundleName Sonat
set_string CFBundleDisplayName Sonat
set_string CFBundleShortVersionString 0.4.0
set_string CFBundleVersion 0.4.0
set_string CFBundleIconFile Sonat.icns
if /usr/bin/plutil -extract CFBundleIconName raw -o - "$plist" >/dev/null 2>&1; then
  /usr/bin/plutil -remove CFBundleIconName "$plist"
fi
iconset="$stage/Sonat.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$source_dir/app/sonat.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  /usr/bin/sips -z "$retina" "$retina" "$source_dir/app/sonat.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset" -o "$bundle/Contents/Resources/Sonat.icns"
set_string NSMicrophoneUsageDescription 'Sonat записывает ваш голос для диктофона и звонков.'
set_string NSAudioCaptureUsageDescription 'Sonat записывает голоса собеседников из системного звука.'
set_string NSScreenCaptureUsageDescription 'Sonat получает звук звонка через системный захват.'
resources="$bundle/Contents/Resources/app"
mkdir -p "$resources"
ditto "$source_dir/app" "$resources/app"
cp "$source_dir/package.json" "$resources/"
# The binaries in an Electron ZIP can have linker signatures without a resource seal.
# Sign nested code in post-order, leaving symlinks inside versioned frameworks intact.
echo 'Подготавливается приложение и проверяется его подпись…'
frameworks="$bundle/Contents/Frameworks"
/usr/bin/find "$frameworks" -depth \( -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -o -type f \( -perm -0100 -o -name '*.dylib' -o -name '*.so' \) \) -print0 > "$stage/nested-code"
while IFS= read -r -d '' item; do
  if [[ -d "$item" ]]; then
    /usr/bin/codesign --force --sign - "$item"
  elif [[ "$(/usr/bin/file -b "$item")" == *Mach-O* ]]; then
    if ! /usr/bin/codesign --verify "$item" 2>/dev/null; then
      /usr/bin/codesign --force --sign - "$item"
    fi
  fi
done < "$stage/nested-code"
/usr/bin/codesign --force --sign - --identifier com.stepancyberpsy.sonat "$bundle"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$bundle"
mv -n "$bundle" "$target"
echo "Sonat установлен в $target"
if [[ "${1:-}" != "--no-open" ]]; then open "$target"; fi
