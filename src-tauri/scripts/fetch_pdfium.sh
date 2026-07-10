#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 macos-arm64|windows-x64|linux-x64|linux-arm64" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

case "$1" in
  macos-arm64)
    asset_arch="mac-arm64"
    output_arch="macos-arm64"
    lib_path="lib/libpdfium.dylib"
    output_name="libpdfium.dylib"
    ;;
  windows-x64)
    asset_arch="win-x64"
    output_arch="windows-x64"
    lib_path="bin/pdfium.dll"
    output_name="pdfium.dll"
    ;;
  linux-x64)
    asset_arch="linux-x64"
    output_arch="linux-x64"
    lib_path="lib/libpdfium.so"
    output_name="libpdfium.so"
    ;;
  linux-arm64)
    asset_arch="linux-arm64"
    output_arch="linux-arm64"
    lib_path="lib/libpdfium.so"
    output_name="libpdfium.so"
    ;;
  *)
    usage
    exit 2
    ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tauri_dir="$(cd -- "${script_dir}/.." && pwd)"
pdfium_dir="${tauri_dir}/pdfium"
version="$(tr -d '[:space:]' < "${pdfium_dir}/VERSION")"
if [[ -n "${XCVT_PDFIUM_CACHE_DIR:-}" ]]; then
  cache_root="${XCVT_PDFIUM_CACHE_DIR}"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  cache_root="${HOME}/Library/Caches/xcvt/pdfium"
else
  cache_root="${XDG_CACHE_HOME:-${HOME}/.cache}/xcvt/pdfium"
fi
asset="pdfium-${asset_arch}.tgz"
url="https://github.com/bblanchon/pdfium-binaries/releases/download/${version}/${asset}"
cache_dir="${cache_root}/${version//\//_}"
archive="${cache_dir}/${asset}"
extract_dir="${cache_dir}/${asset%.tgz}"
shared_output_dir="${cache_dir}/${output_arch}"
output_dir="${pdfium_dir}/${output_arch}"

mkdir -p "${cache_dir}" "${extract_dir}" "${shared_output_dir}" "${output_dir}"

if [[ ! -f "${archive}" ]]; then
  curl -fL --retry 3 --retry-delay 2 -o "${archive}" "${url}"
fi

expected="$(awk -v file="${asset}" '$2 == file { print $1 }' "${pdfium_dir}/SHA256SUMS")"
if [[ -z "${expected}" ]]; then
  echo "missing checksum for ${asset}" >&2
  exit 1
fi

actual="$(shasum -a 256 "${archive}" | awk '{ print $1 }')"
if [[ "${actual}" != "${expected}" ]]; then
  rm -f "${archive}"
  echo "checksum mismatch for ${asset}: expected ${expected}, got ${actual}" >&2
  exit 1
fi

rm -rf "${extract_dir}"
mkdir -p "${extract_dir}"
tar -xzf "${archive}" -C "${extract_dir}"

if [[ ! -f "${extract_dir}/${lib_path}" ]]; then
  echo "expected ${lib_path} in ${asset}" >&2
  exit 1
fi

cp "${extract_dir}/${lib_path}" "${shared_output_dir}/${output_name}"
cp "${shared_output_dir}/${output_name}" "${output_dir}/${output_name}"
echo "${output_dir}/${output_name}"
