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

# The application and its SDKs may use the node user's home for ordinary
# control-plane cache files. Project package managers run only inside E2B.
mkdir -p "$node_home/.cache"
chown -R node:node "$node_home"

exec gosu node "$@"
