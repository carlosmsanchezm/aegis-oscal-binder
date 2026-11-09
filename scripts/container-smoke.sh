#!/usr/bin/env bash
# Build the image, wait until the container is healthy, then check:
#   (a) the home page responds
#   (b) the Use sample load path (Rev5 sample upload, FAIL 1 of 12)
#   (c) WIP export returns well-formed OSCAL XML
# Also checks the gold fixture (FAIL 3 of 12) on a separate session.
# Removes the container on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${CONTAINER_CLI:-docker}"
IMAGE="${IMAGE:-aegis-oscal-binder:smoke}"
NAME="${NAME:-aegis-oscal-smoke-$$}"
PORT="${PORT:-3000}"
if [[ -z "${AEGIS_COMMIT:-}" ]]; then
  AEGIS_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
COMMIT="${AEGIS_COMMIT:-dev}"
DATA_DIR="${AEGIS_DATA_DIR:-/data}"
tmpdir=""

cleanup() {
  "$CLI" rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ -n "$tmpdir" && -d "$tmpdir" ]]; then
    rm -rf "$tmpdir"
  fi
}
trap cleanup EXIT

echo "Building ${IMAGE} with ${CLI}"
build_flags=()
if [[ "$CLI" == "podman" ]]; then
  # Podman writes OCI images by default and drops HEALTHCHECK. Docker format keeps it.
  build_flags+=(--format docker)
fi
"$CLI" build "${build_flags[@]}" --build-arg "AEGIS_COMMIT=${COMMIT}" -t "$IMAGE" "$ROOT"

"$CLI" rm -f "$NAME" >/dev/null 2>&1 || true
"$CLI" run -d --name "$NAME" \
  -p "${PORT}:${PORT}" \
  -e "PORT=${PORT}" \
  -e "AEGIS_COMMIT=${COMMIT}" \
  -e "AEGIS_DATA_DIR=${DATA_DIR}" \
  "$IMAGE"

echo "Waiting for health on port ${PORT}"
status="missing"
healthy=0
for _ in $(seq 1 60); do
  status="$("$CLI" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME" 2>/dev/null || echo missing)"
  # Podman schedules HEALTHCHECK with a systemd user timer. Without that session
  # the status stays "starting" even though the image check is fine, so run it
  # explicitly. Docker updates status on its own; this command is podman-only.
  if [[ "$status" == "starting" && "$CLI" == "podman" ]]; then
    "$CLI" healthcheck run "$NAME" >/dev/null 2>&1 || true
    status="$("$CLI" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME" 2>/dev/null || echo missing)"
  fi
  if [[ "$status" == "healthy" ]]; then
    healthy=1
    break
  fi
  if [[ "$status" == "unhealthy" ]]; then
    echo "Container became unhealthy" >&2
    "$CLI" logs "$NAME" >&2 || true
    exit 1
  fi
  running="$("$CLI" inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)"
  if [[ "$running" != "true" ]]; then
    echo "Container exited before it was healthy" >&2
    "$CLI" logs "$NAME" >&2 || true
    exit 1
  fi
  sleep 2
done
if [[ "$healthy" != "1" ]]; then
  echo "Timed out waiting for health (last status: ${status})" >&2
  "$CLI" logs "$NAME" >&2 || true
  exit 1
fi

BASE="http://127.0.0.1:${PORT}"
tmpdir="$(mktemp -d)"

curl -fsS "$BASE/" -o "$tmpdir/home.html"
short="$(printf '%s' "$COMMIT" | tr -d '[:space:]')"
if [[ -z "$short" ]]; then
  short="local"
else
  short="$(printf '%s' "$short" | cut -c1-7)"
fi
# The empty-workspace button is client-rendered after session sync, so the
# first HTML document is the shell. Confirm that shell, the footer SHA, and
# that the shipped page bundle still contains the Use sample control.
python3 - "$tmpdir/home.html" "$short" <<'PY'
import re, sys
html = open(sys.argv[1], encoding="utf-8").read()
short = sys.argv[2]
assert "OSCAL binder" in html, "home page missing shell"
match = re.search(r'data-testid="build-version">(.*?)</span>', html)
assert match, "footer build label missing"
text = re.sub(r"<!--.*?-->", "", match.group(1))
text = re.sub(r"\s+", " ", text).strip()
assert text == f"build {short}", text
PY
found_sample=0
while IFS= read -r src; do
  [[ -z "$src" ]] && continue
  if curl -fsS "$BASE$src" | grep -q "Use sample"; then
    found_sample=1
    break
  fi
done < <(python3 - "$tmpdir/home.html" <<'PY'
import re, sys
html = open(sys.argv[1], encoding="utf-8").read()
for src in re.findall(r'src="(/_next/static/[^"]+\.js)"', html):
    print(src)
PY
)
if [[ "$found_sample" != "1" ]]; then
  echo "Use sample control was not in the shipped page bundle" >&2
  exit 1
fi

jar="$tmpdir/cookies.txt"
curl -fsS -c "$jar" -b "$jar" \
  -H 'content-type: application/json' \
  -d '{"catalog":"fedramp-rev5"}' \
  "$BASE/api/catalogs/select" -o "$tmpdir/select.json"
python3 - "$tmpdir/select.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc.get("ok") is True, doc
assert doc["packageState"]["catalog"]["id"] == "fedramp-rev5", doc
PY

curl -fsS "$BASE/samples/sample-oscal-ssp-rev5.json" -o "$tmpdir/sample.json"
python3 - "$tmpdir/sample.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert "system-security-plan" in doc, doc
PY

curl -fsS -c "$jar" -b "$jar" \
  -F "catalog=fedramp-rev5" \
  -F "file=@${tmpdir}/sample.json;filename=sample-oscal-ssp-rev5.json;type=application/json" \
  "$BASE/api/oscal/ingest" -o "$tmpdir/ingest.json"
python3 - "$tmpdir/ingest.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc.get("ok") is True, doc
gate = doc["packageState"]["gate"]
assert gate["status"] == "FAIL", gate
assert gate["incomplete"] == 1, gate
assert "1 of 12" in gate["label"], gate
PY

curl -fsS -c "$jar" -b "$jar" \
  -H 'content-type: application/json' \
  -d '{"responsibleRole":"System Owner"}' \
  "$BASE/api/controls/AU-2/save" -o "$tmpdir/save.json"
python3 - "$tmpdir/save.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc.get("ok") is True, doc
gate = doc["packageState"]["gate"]
assert gate["status"] == "FAIL", gate
assert gate["incomplete"] == 1, gate
assert gate["label"] == "1 of 12 incomplete", gate
au2 = next(control for control in doc["packageState"]["controls"] if control["id"] == "AU-2")
assert au2["responsibleRole"] == "System Owner", au2
assert au2["complete"] is False, au2
assert au2["missing"] == ["evidence"], au2
PY

curl -fsS -c "$jar" -b "$jar" -X POST "$BASE/api/oscal/export" -o "$tmpdir/export.json"
python3 - "$tmpdir/export.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc.get("ok") is True, doc
assert str(doc.get("filename", "")).endswith(".xml"), doc
assert doc["packageState"]["gate"]["status"] == "FAIL", doc
assert "<system-security-plan" in doc.get("xml", ""), "export response did not carry the XML"
assert 'role-id="system-owner"' in doc["xml"], "partial save was missing from the export body"
PY

curl -fsS -c "$jar" -b "$jar" "$BASE/api/artifacts/oscal" -o "$tmpdir/export.xml"
python3 - "$tmpdir/export.xml" "$tmpdir/export.json" <<'PY'
import json, sys
import xml.etree.ElementTree as ET
path, meta = sys.argv[1], sys.argv[2]
root = ET.parse(path).getroot()
assert root.tag.endswith("system-security-plan"), root.tag
xml = open(path, encoding="utf-8").read()
body = json.load(open(meta, encoding="utf-8"))
assert xml == body["xml"], "downloaded XML differed from the export response"
assert 'role-id="system-owner"' in xml
PY

gold_jar="$tmpdir/gold.txt"
curl -fsS -c "$gold_jar" -b "$gold_jar" \
  -H 'content-type: application/json' \
  -d '{"catalog":"fedramp-rev5"}' \
  "$BASE/api/catalogs/select" -o "$tmpdir/gold-select.json"
curl -fsS -c "$gold_jar" -b "$gold_jar" \
  -H 'content-type: application/json' \
  -d '{"fixture":"gold"}' \
  "$BASE/api/fixtures/load" -o "$tmpdir/gold.json"
python3 - "$tmpdir/gold.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc.get("ok") is True, doc
gate = doc["packageState"]["gate"]
assert gate["status"] == "FAIL", gate
assert gate["incomplete"] == 3, gate
assert "3 of 12" in gate["label"], gate
PY

echo "container smoke ok"
