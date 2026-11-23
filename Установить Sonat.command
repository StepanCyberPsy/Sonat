#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
source_dir="$PWD"
sonat_version=0.5.0
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
if [[ -d "$target" && "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$target/Contents/Info.plist" 2>/dev/null || true)" != "0.5.0" ]]; then
  target="$target_dir/Sonat 0.5.0.app"
fi
if [[ -e "$target" ]]; then
  echo "Sonat уже находится в $target"
  if [[ "${1:-}" != "--no-open" ]]; then open -R "$target"; fi
  exit 0
fi
mkdir -p "$target_dir"
stage="$(mktemp -d "$target_dir/.sonat-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
# The GitHub source ZIP installs the tested release; no compiler is needed.
# Only the macOS build workflow assembles the runtime and native helper below.
if [[ "${SONAT_BUILD_FROM_SOURCE:-0}" != 1 ]]; then
  asset="Sonat-$sonat_version-darwin-$arch.zip"
  release_url="https://github.com/StepanCyberPsy/Sonat/releases/download/v$sonat_version/$asset"
  echo "Загружается готовый Sonat $sonat_version для вашего Mac…"
  if ! curl --fail --show-error --location --retry 2 --proto '=https' --proto-redir '=https' \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/StepanCyberPsy/Sonat/releases/tags/v$sonat_version" -o "$stage/release.json"; then
    echo "Готовый релиз Sonat $sonat_version ещё недоступен. Повторите установку после публикации релиза."
    exit 1
  fi
  # JXA and Foundation are included in macOS; Node, Python and Xcode are unnecessary.
  release_digest="$(/usr/bin/osascript -l JavaScript - "$stage/release.json" "$sonat_version" "$asset" "$release_url" <<'JXA'
ObjC.import('Foundation');
function run(args) {
  const release = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(args[0], $.NSUTF8StringEncoding, null).js);
  if (release.tag_name !== 'v' + args[1] || release.draft !== false || release.prerelease !== false) throw Error('Неверный релиз');
  const assets = release.assets.filter(asset => asset.name === args[2]);
  if (assets.length !== 1 || assets[0].browser_download_url !== args[3] || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest || '')) throw Error('Нет проверенной сборки для этого Mac');
  return assets[0].digest.slice(7);
}
JXA
)"
  curl --fail --show-error --location --retry 2 --proto '=https' --proto-redir '=https' \
    "$release_url" -o "$stage/$asset"
  (cd "$stage" && echo "$release_digest  $asset" | shasum -a 256 -c -)
  /usr/bin/ditto -x -k "$stage/$asset" "$stage/release"
  bundle="$stage/release/Sonat.app"
  plist="$bundle/Contents/Info.plist"
  test "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$plist")" = com.stepancyberpsy.sonat
  test "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$plist")" = "$sonat_version"
  metadata="$bundle/Contents/Resources/sonat-release.json"
  test "$(/usr/bin/plutil -extract repository raw -o - "$metadata")" = StepanCyberPsy/Sonat
  test "$(/usr/bin/plutil -extract version raw -o - "$metadata")" = "$sonat_version"
  test "$(/usr/bin/plutil -extract arch raw -o - "$metadata")" = "$arch"
  test -x "$bundle/Contents/Helpers/SonatCallProbe"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$bundle"
  mv -n "$bundle" "$target"
  echo "Sonat установлен в $target"
  if [[ "${1:-}" != "--no-open" ]]; then open "$target"; fi
  exit 0
fi
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
set_string CFBundleShortVersionString 0.5.0
set_string CFBundleVersion 0.5.0
set_string CFBundleIconFile Sonat.icns
set_string LSMinimumSystemVersion 14.2
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
# Build only in CI/development; end users download this ready helper in the app.
echo 'Собирается системный детектор звонков…'
helpers="$bundle/Contents/Helpers"
mkdir -p "$helpers"
compiler_arch="$arch"
if [[ "$compiler_arch" == x64 ]]; then compiler_arch=x86_64; fi
xcrun clang -fobjc-arc -O2 -Wall -Wextra -arch "$compiler_arch" -mmacosx-version-min=14.2 \
  "$source_dir/native/call-probe.m" -framework Foundation -framework AppKit \
  -framework CoreAudio -framework CoreGraphics -o "$helpers/SonatCallProbe"
/usr/bin/codesign --force --sign - --identifier com.stepancyberpsy.sonat.callprobe "$helpers/SonatCallProbe"
# The binaries in an Electron ZIP can have linker signatures without a resource seal.
# Sign nested code in post-order, leaving symlinks inside versioned frameworks intact.
echo 'Подготавливается приложение и проверяется его подпись…'
frameworks="$bundle/Contents/Frameworks"
# Intel distributions also contain unsigned helpers. Seal all standalone Mach-O
# files before signing any wrapper: sibling order in a directory is unspecified.
# codesign can treat a framework's main executable as its enclosing bundle.
# Its owning wrapper signs that executable in the second pass.
/usr/bin/find "$frameworks" -type f \( -perm -0100 -o -name '*.dylib' -o -name '*.so' -o -path '*/Helpers/*' \) -print0 > "$stage/nested-files"
while IFS= read -r -d '' item; do
  case "$item" in
    *.framework/Versions/*)
      framework_name="${item%.framework/Versions/*}"
      framework_name="${framework_name##*/}"
      if [[ "${item##*/}" == "$framework_name" ]]; then continue; fi ;;
  esac
  if [[ "$(/usr/bin/file -b "$item")" == *Mach-O* ]] && ! /usr/bin/codesign --verify "$item" 2>/dev/null; then
    /usr/bin/codesign --force --sign - "$item"
  fi
done < "$stage/nested-files"
/usr/bin/find "$frameworks" -depth -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -print0 > "$stage/nested-bundles"
while IFS= read -r -d '' item; do
  /usr/bin/codesign --force --sign - "$item"
done < "$stage/nested-bundles"
/usr/bin/codesign --force --sign - --identifier com.stepancyberpsy.sonat "$bundle"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$bundle"
mv -n "$bundle" "$target"
echo "Sonat установлен в $target"
if [[ "${1:-}" != "--no-open" ]]; then open "$target"; fi
