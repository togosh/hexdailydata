#!/bin/sh
set -eu
# Only fixed roots of already ownership-checked project volumes; never recursive.
for path in /db-data /state /exports /provider /maintenance /backup; do
  test -d "$path" && test ! -L "$path"
done
chown 999:999 /db-data
chmod 700 /db-data
chown 1001:1000 /state /exports /maintenance /backup
chmod 2770 /state /exports /maintenance /backup
# Shared readable cooldowns, but the sticky parent and distinct UIDs prevent either
# runtime role from replacing or editing the other's persisted backoff.
chown 0:1000 /provider
chmod 1770 /provider
for role in api worker; do
  path="/provider/$role.json"
  test ! -L "$path"
  if [ ! -e "$path" ]; then printf 0 > "$path"; fi
  test -f "$path"
  if [ "$role" = api ]; then chown 1000:1000 "$path"; else chown 1001:1000 "$path"; fi
  chmod 640 "$path"
done
