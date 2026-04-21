#!/usr/bin/env bash
set -euo pipefail

mkdir -p sdk/src/idl
cp -f target/idl/*.json sdk/src/idl/
echo "IDL synced -> sdk/src/idl"
