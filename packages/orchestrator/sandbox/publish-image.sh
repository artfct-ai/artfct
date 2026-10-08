#!/bin/sh
set -eu
image="docker.io/artfct/sandbox:$(git rev-parse HEAD)"
out=dist/sandbox-image
mkdir -p "$out"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  --push \
  --metadata-file "$out/metadata.json" \
  --file sandbox/Dockerfile \
  --tag "$image" \
  ../..
echo "$image@$(jq -r '."containerimage.digest"' "$out/metadata.json")" > "$out/published-image"
