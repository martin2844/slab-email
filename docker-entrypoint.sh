#!/bin/sh
set -eu

umask 077
chmod 700 /data
exec "$@"
