#!/bin/sh
set -eu

data_dir="/app/packages/api/data"
node_uid="$(id -u node)"
node_home="/home/node"

# Existing releases wrote the named volume as root. Fix ownership once during
# the upgrade, then run the application itself without root privileges.
if [ "$(stat -c '%u' "$data_dir")" != "$node_uid" ]; then
  chown -R node:node "$data_dir"
fi

# Package-manager caches must stay writable when Quillra installs dependencies
# inside customer repositories. Explicit packageManager fields are handled by
# Corepack; older pnpm repositories use the compatible pnpm 9 default.
mkdir -p "$node_home/.cache" "$node_home/.local/share/pnpm"
chown -R node:node "$node_home"

exec gosu node "$@"
