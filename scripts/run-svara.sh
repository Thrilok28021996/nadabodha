#!/usr/bin/env bash
# Launch Svara with the project's Python environment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${SVARA_PYTHON:-/Volumes/personal/conda_envs/sovereign/bin/python3}"

if [ ! -x "$PY" ]; then
  PY="$(command -v python3 || true)"
fi
if [ -z "${PY:-}" ]; then
  echo "No Python interpreter found. Set SVARA_PYTHON." >&2
  exit 1
fi

cd "$ROOT"
exec "$PY" -m svara "$@"
