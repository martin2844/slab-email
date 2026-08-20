#!/bin/sh
set -eu

image=${SLAB_EMAIL_SMOKE_IMAGE:-slab-email:smoke}
port=${SLAB_EMAIL_SMOKE_PORT:-39681}
suffix=${GITHUB_RUN_ID:-local}-$$
container=slab-email-smoke-$suffix
volume=slab-email-smoke-data-$suffix
temporary_directory=$(mktemp -d)
admin_file=$temporary_directory/admin-key
master_file=$temporary_directory/master-key
admin_key=testing-only-email-admin-key-0123456789abcdef
master_key=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

printf '%s\n' "$admin_key" > "$admin_file"
printf '%s\n' "$master_key" > "$master_file"
chmod 444 "$admin_file" "$master_file"
docker volume create "$volume" >/dev/null

common_args="--volume $volume:/data --mount type=bind,src=$admin_file,dst=/run/secrets/email-admin-key,readonly --mount type=bind,src=$master_file,dst=/run/secrets/email-master-key,readonly"

# shellcheck disable=SC2086
docker run --rm --volume "$volume:/data" "$image" node dist/db/migrate.js >/dev/null

# shellcheck disable=SC2086
docker run --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:6981" \
  $common_args \
  --env HOST=0.0.0.0 \
  --env SLAB_EMAIL_ADMIN_KEY_FILE=/run/secrets/email-admin-key \
  --env SLAB_EMAIL_MASTER_KEY_FILE=/run/secrets/email-master-key \
  --env DATABASE_PATH=/data/slab-email.db \
  --env SKIP_MIGRATIONS=true \
  "$image" >/dev/null

curl --retry 30 --retry-delay 1 --retry-all-errors -fsS \
  "http://127.0.0.1:${port}/ready" >/dev/null
curl -fsS \
  -H "Authorization: Bearer $admin_key" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Smoke profile","readEnabled":true,"draftEnabled":false,"sendEnabled":false,"accountIds":[]}' \
  "http://127.0.0.1:${port}/api/access-profiles" >/dev/null

test "$(docker exec "$container" sh -c "awk '/^Uid:/{print \$2}' /proc/1/status")" = "1000"
test "$(docker exec "$container" stat -c '%a' /data)" = "700"
test "$(docker exec "$container" stat -c '%a' /data/slab-email.db)" = "600"
if docker exec "$container" sh -c 'command -v npm >/dev/null 2>&1 || command -v yarn >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1'; then
  echo "The production image must not include package-manager CLIs." >&2
  exit 1
fi
if docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -F "$admin_key" >/dev/null \
  || docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -F "$master_key" >/dev/null; then
  echo "Email secrets must not be stored in container environment metadata." >&2
  exit 1
fi

docker restart "$container" >/dev/null
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS \
  "http://127.0.0.1:${port}/ready" >/dev/null
curl -fsS \
  -H "Authorization: Bearer $admin_key" \
  "http://127.0.0.1:${port}/api/access-profiles" | grep -F 'Smoke profile' >/dev/null

echo "Slab Email container smoke passed."
