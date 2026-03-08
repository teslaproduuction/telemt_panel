#!/usr/bin/env bash
set -euo pipefail

echo "=== Telemt Panel Builder ==="
echo ""

# Check Docker
if ! docker version &>/dev/null; then
  echo "ERROR: Docker is not running."
  exit 1
fi

PLATFORMS="${1:-linux/amd64,linux/arm64}"

echo "[1/4] Building frontend..."
docker build --target frontend -t telemt-panel-frontend .

echo "[2/4] Building binaries for: ${PLATFORMS}..."
mkdir -p release

for platform in ${PLATFORMS//,/ }; do
  os="${platform%/*}"
  arch="${platform#*/}"

  if [ "$arch" = "arm64" ]; then
    label="aarch64"
  else
    label="x86_64"
  fi

  outname="telemt-panel-${label}-${os}"
  echo "  -> ${outname}"

  docker build \
    --build-arg TARGETARCH="${arch}" \
    --platform "${platform}" \
    -t "telemt-panel-builder-${arch}" .

  container_id=$(docker create "telemt-panel-builder-${arch}")
  docker cp "${container_id}:/usr/local/bin/telemt-panel" "./release/${outname}"
  docker rm "${container_id}" >/dev/null 2>&1
done

echo "[3/4] Generating checksums..."
cd release
sha256sum telemt-panel-* > SHA256SUMS
cd ..

echo "[4/4] Done!"
echo ""
echo "Binaries in ./release/:"
ls -lh release/
