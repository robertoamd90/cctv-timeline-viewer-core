#!/bin/sh
# Generate the self-contained build context required by a local HA Supervisor build.
#
# Usage (run from this repository root):
#   ./scripts/package-local-addon.sh          # stable and beta
#   ./scripts/package-local-addon.sh stable   # stable only
#   ./scripts/package-local-addon.sh beta     # beta only
#
# The command recreates addons/cctv_viewer and/or addons/cctv_viewer_beta from
# the canonical application and packaging templates. Do not edit these
# generated directories manually; they are intentionally ignored by Git.
#
# To test it on Home Assistant, copy the generated directory to the local
# add-on directory on Home Assistant, then rebuild and start the app:
#   <HA local addons directory>/cctv_viewer
#   <HA local addons directory>/cctv_viewer_beta
#
# Public installations do not use this script. They add the GitHub repository
# in Home Assistant and pull the published GHCR image instead.
set -eu

for source in Dockerfile requirements.txt .dockerignore ctv_server ctv_web \
  packaging/homeassistant scripts/render_local_addon.py; do
  if [ ! -e "$source" ]; then
    echo "Run this script from the repository root; required source is missing: $source" >&2
    exit 1
  fi
done

requested="${1:-all}"
case "$requested" in
  all) channels="stable beta" ;;
  stable|beta) channels="$requested" ;;
  *)
    echo "Usage: $0 [stable|beta]" >&2
    exit 1
    ;;
esac

for channel in $channels; do
  if [ "$channel" = "stable" ]; then
    addon="cctv_viewer"
  else
    addon="cctv_viewer_beta"
  fi
  output_dir="addons/$addon"
  rm -rf "$output_dir"
  mkdir -p "$output_dir"

  cp Dockerfile requirements.txt .dockerignore "$output_dir/"
  cp -R ctv_server ctv_web "$output_dir/"
  cp CHANGELOG.md \
     packaging/homeassistant/DOCS.md \
     packaging/homeassistant/README.md \
     "$output_dir/"
  python3 scripts/render_local_addon.py "$channel" "$output_dir"
  printf '%s\n' "Local Home Assistant build context generated at: $output_dir"
done
