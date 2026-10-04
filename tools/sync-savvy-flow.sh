#!/usr/bin/env bash
# Refreshes plugins/savvy-flow from johnnyvizz/claude-kit and reapplies the one local change:
# the savvy-fable tier runs on Opus at max effort instead of Fable, for accounts without Fable access.
# Safe to run any time; it changes files only when upstream changed. Usage: tools/sync-savvy-flow.sh
set -euo pipefail

UPSTREAM="https://github.com/JohnnyVizz/claude-kit.git"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/plugins/savvy-flow"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 "$UPSTREAM" "$WORK/claude-kit"
SRC="$WORK/claude-kit/plugins/savvy-flow"
COMMIT="$(git -C "$WORK/claude-kit" rev-parse --short HEAD)"

rm -rf "$DEST"
cp -R "$SRC" "$DEST"
cp "$WORK/claude-kit/LICENSE" "$DEST/LICENSE"   # MIT: the notice travels with the copy

# The patch: Fable tier on Opus, max effort.
FABLE="$DEST/agents/savvy-fable.md"
sed -i.bak -e 's/^model: fable$/model: opus/' -e 's/^effort: high$/effort: max/' \
  -e 's/(Fable, high effort)/(Opus, max effort; Fable unavailable)/' "$FABLE"
SKILL="$DEST/skills/savvy-flow/SKILL.md"
sed -i.bak -e 's#| Fable | `savvy-fable` | Fable / high |#| Fable | `savvy-fable` | Opus / max (stands in for Fable) |#' "$SKILL"
rm -f "$FABLE.bak" "$SKILL.bak"
grep -q '^model: opus$' "$FABLE" || { echo "patch failed: savvy-fable model line changed upstream" >&2; exit 1; }

# The version carries the upstream commit, so every upstream change reaches installed copies.
python3 - "$DEST/.claude-plugin/plugin.json" "$COMMIT" <<'PY'
import json, sys
path, commit = sys.argv[1], sys.argv[2]
manifest = json.load(open(path))
upstream = manifest.get("version", "0.0.0").split("-opus")[0]
manifest["version"] = f"{upstream}-opus.{commit}"
manifest["description"] = (manifest.get("description", "") +
  f" Copy of johnnyvizz/claude-kit@{commit} with the savvy-fable tier on Opus at max effort.")
open(path, "w").write(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
PY

echo "savvy-flow synced from claude-kit@$COMMIT"
