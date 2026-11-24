#!/bin/sh
# Removes the user-level launcher, icon and desktop file.
# Does not delete models. Pass --purge to also delete app data (engines, chats, settings).
set -eu
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
rm -f "$HOME/.local/bin/black-mirror"
rm -f "$HOME/.local/share/applications/black-mirror.desktop"
rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/black-mirror.png"
rm -rf "$DATA_HOME/black-mirror/app"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$DATA_HOME/black-mirror"
  rm -rf "$HOME/.black-mirror"
  echo "Purged $DATA_HOME/black-mirror (settings, engines, conversations). Model files elsewhere were not touched."
else
  echo "Launcher removed. Settings and engines were kept in $DATA_HOME/black-mirror"
  echo "Re-run with --purge to delete that directory too. Model files are never deleted by this script."
fi
