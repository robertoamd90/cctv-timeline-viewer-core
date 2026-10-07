#!/usr/bin/env bash
# Deploy the PHP shared-host backend and its frontend over SSH.
#
# Required .env.prod.local values:
#   REMOTE_HOST=example.com
#   REMOTE_USER=deploy-user
#   REMOTE_DIR=/home/deploy-user/apps/cctv-timeline-viewer-core
#
# Optional values:
#   REMOTE_PORT=22
#   PHP_BIN=php
#   INDEX_DAYS=1

set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
env_file="$project_dir/.env.prod.local"

if [[ ! -f "$env_file" ]]; then
    printf 'Missing %s. Create it with REMOTE_HOST, REMOTE_USER and REMOTE_DIR.\n' "$env_file" >&2
    exit 1
fi

# This is a local, trusted deployment configuration. Quoted values and comments
# are supported by the shell syntax used in conventional .env files.
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

: "${REMOTE_HOST:?REMOTE_HOST must be set in .env.prod.local}"
: "${REMOTE_USER:?REMOTE_USER must be set in .env.prod.local}"
: "${REMOTE_DIR:?REMOTE_DIR must be set in .env.prod.local}"

if [[ "$REMOTE_DIR" != /* ]]; then
    printf 'REMOTE_DIR must be an absolute path: %s\n' "$REMOTE_DIR" >&2
    exit 1
fi

php_bin="${PHP_BIN:-php}"
index_days="${INDEX_DAYS:-1}"
if ! [[ "$index_days" =~ ^[1-9][0-9]*$ ]]; then
    printf 'INDEX_DAYS must be a positive integer: %s\n' "$index_days" >&2
    exit 1
fi

remote_target="$REMOTE_USER@$REMOTE_HOST"
ssh_options=()
if [[ -n "${REMOTE_PORT:-}" ]]; then
    if ! [[ "$REMOTE_PORT" =~ ^[1-9][0-9]*$ ]]; then
        printf 'REMOTE_PORT must be a positive integer: %s\n' "$REMOTE_PORT" >&2
        exit 1
    fi
    ssh_options+=(-p "$REMOTE_PORT")
fi

remote_has_config() {
    ssh "${ssh_options[@]}" "$remote_target" bash -s -- "$REMOTE_DIR" <<'REMOTE_CHECK'
set -euo pipefail
test -f "$1/ctv_php/config.php"
REMOTE_CHECK
}

printf 'Creating deployment directory on %s...\n' "$remote_target"
ssh "${ssh_options[@]}" "$remote_target" bash -s -- "$REMOTE_DIR" <<'REMOTE_MKDIR'
set -euo pipefail
mkdir -p -- "$1"
REMOTE_MKDIR

configured=false
if remote_has_config; then
    configured=true
fi

printf 'Synchronizing ctv_php and ctv_web...\n'
rsync -az --human-readable \
    --exclude='config.php' \
    --exclude='.htpasswd*' \
    --exclude='.setup-token' \
    --exclude='.setup.lock' \
    --exclude='var/' \
    -e "ssh${REMOTE_PORT:+ -p $REMOTE_PORT}" \
    "$project_dir/ctv_php" "$project_dir/ctv_web" \
    "$remote_target:$REMOTE_DIR/"

run_setup=true
if "$configured"; then
    read -r -p 'A server configuration already exists. Update it with setup.php? [y/N] ' answer
    case "$answer" in
        y|Y|yes|YES) ;;
        *) run_setup=false ;;
    esac
fi

if "$run_setup"; then
    printf 'Running the interactive server setup...\n'
    printf -v setup_command 'cd -- %q && exec %q ctv_php/setup.php' "$REMOTE_DIR" "$php_bin"
    printf -v quoted_setup_command '%q' "$setup_command"
    ssh -t "${ssh_options[@]}" "$remote_target" "bash -lc $quoted_setup_command"
else
    printf 'Keeping the existing server configuration.\n'
fi

printf 'Discovering cameras and indexing recordings (%s day(s))...\n' "$index_days"
ssh "${ssh_options[@]}" "$remote_target" bash -s -- "$REMOTE_DIR" "$php_bin" "$index_days" <<'REMOTE_INDEX'
set -euo pipefail
cd -- "$1"
"$2" ctv_php/bin/index.php --discover
"$2" ctv_php/bin/index.php --days="$3"
REMOTE_INDEX

printf 'Deployment complete.\n'
