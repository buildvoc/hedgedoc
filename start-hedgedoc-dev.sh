#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Never allow inherited HedgeDoc variables to override repo .env
for var in $(env | awk -F= '/^HD_/ {print $1}'); do
    unset "$var"
done
unset CADDY_HOST 2>/dev/null || true

source "$HOME/.nvm/nvm.sh"
nvm use 22 >/dev/null

exec yarn start:dev
