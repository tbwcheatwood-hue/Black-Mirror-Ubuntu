#!/bin/sh
# User-level install for the Black Mirror Ubuntu edition.
# No root, no driver changes, no systemd enablement, no Docker.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DEST="$DATA_HOME/black-mirror/app"
BIN_DIR="$HOME/.local/bin"
DESK_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
mkdir -p "$APP_DEST" "$BIN_DIR" "$DESK_DIR" "$ICON_DIR"

if [ -d "$ROOT/dist/linux-unpacked" ]; then
  rm -rf "$APP_DEST/linux-unpacked"
  cp -a "$ROOT/dist/linux-unpacked" "$APP_DEST/linux-unpacked"
  LAUNCH="$APP_DEST/linux-unpacked/black-mirror"
  if [ ! -x "$LAUNCH" ]; then
    LAUNCH=$(find "$APP_DEST/linux-unpacked" -maxdepth 2 -type f -name 'black-mirror' -perm -111 | head -n 1 || true)
  fi
elif ls "$ROOT"/dist/black-mirror-*.tar.gz >/dev/null 2>&1; then
  rm -rf "$APP_DEST/portable"
  mkdir -p "$APP_DEST/portable"
  tar -xzf "$(ls -1 "$ROOT"/dist/black-mirror-*.tar.gz | head -n 1)" -C "$APP_DEST/portable"
  LAUNCH=$(find "$APP_DEST/portable" -maxdepth 3 -type f -name 'black-mirror' -perm -111 | head -n 1 || true)
else
  # Source checkout: launcher runs Electron from this tree (Node 18+ required).
  printf '%s\n' '#!/bin/sh' "cd $(printf '%q' "$ROOT")" 'exec npm start "$@"' > "$APP_DEST/black-mirror-src.sh"
  chmod 755 "$APP_DEST/black-mirror-src.sh"
  LAUNCH="$APP_DEST/black-mirror-src.sh"
fi

if [ -z "${LAUNCH:-}" ] || [ ! -e "$LAUNCH" ]; then
  echo "No launchable Black Mirror binary was found." >&2
  exit 1
fi

ln -sfn "$LAUNCH" "$BIN_DIR/black-mirror"
cp -f "$ROOT/assets/icon.png" "$ICON_DIR/black-mirror.png"
cat > "$DESK_DIR/black-mirror.desktop" <<EOF
[Desktop Entry]
Name=Black Mirror
Comment=Local LLM studio — your machine, your models, your intelligence
Exec=$BIN_DIR/black-mirror
Icon=black-mirror
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=black-mirror
EOF
chmod 644 "$DESK_DIR/black-mirror.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESK_DIR" >/dev/null 2>&1 || true
fi
echo "Installed launcher: $BIN_DIR/black-mirror"
echo "Desktop entry: $DESK_DIR/black-mirror.desktop"
echo "User data (created on first run): $DATA_HOME/black-mirror"
echo "Engines install only under that data directory. Nothing was added to startup."
