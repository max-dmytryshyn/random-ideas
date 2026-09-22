#!/usr/bin/env bash
set -euo pipefail

UUID="claude-taskbar@maksumus.local"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if ! command -v gnome-shell >/dev/null 2>&1; then
    echo "gnome-shell not found. This is a GNOME Shell extension." >&2
    exit 1
fi

MAJOR="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"

if [ "$MAJOR" -ge 45 ]; then
    SRC="$HERE/gnome45"
elif [ "$MAJOR" -ge 42 ]; then
    SRC="$HERE/gnome42"
else
    echo "GNOME Shell $MAJOR is not supported. Needs 42 or newer." >&2
    exit 1
fi

mkdir -p "$DEST"
cp "$SRC/extension.js" "$SRC/metadata.json" "$DEST/"

echo "Installed for GNOME Shell $MAJOR into:"
echo "  $DEST"
echo
echo "STEP 1 — restart GNOME Shell:"
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "  You are on Wayland. Log out and log back in."
else
    echo "  You are on X11. Press Alt+F2, type  r  , press Enter."
fi
echo
echo "STEP 2 — enable it:"
echo "  gnome-extensions enable $UUID"
echo
echo "Never run 'gnome-shell --replace' to load this."
echo "On a GDM-managed session it takes the whole session down and closes every open window."
