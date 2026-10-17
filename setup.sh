#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-}"
LOCATION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
FIRESTORE_DB="${GOOGLE_CLOUD_FIRESTORE:-live-smartcamera}"
SA_NAME="${ARIS_SA_NAME:-aris-smarthome-sa}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "missing-gcp-project-id" ]]; then
  echo "❌ Error: GOOGLE_CLOUD_PROJECT is not set in ${ENV_FILE} or environment."
  exit 1
fi

ACTIVE_USER="$(gcloud config get-value account 2>/dev/null || true)"
if [[ -z "${ACTIVE_USER}" ]]; then
  echo "❌ Error: No active gcloud account found. Run 'gcloud auth login' first."
  exit 1
fi

PYTHON_BIN="python3"
if [[ -x "${SCRIPT_DIR}/.venv/bin/python" ]]; then
  PYTHON_BIN="${SCRIPT_DIR}/.venv/bin/python"
fi

echo "=========================================================="
echo "🚀 Configuring Aris Smart Home Agent Infrastructure"
echo "   Active User  : ${ACTIVE_USER}"
echo "   Project ID   : ${PROJECT_ID}"
echo "   Location     : ${LOCATION}"
echo "   Firestore DB : ${FIRESTORE_DB}"
echo "   Service Acct : ${SA_EMAIL}"
echo "=========================================================="

# Retry helper for commands sensitive to GCP IAM propagation delays
retry_with_backoff() {
  local max_attempts=6
  local delay=5
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if (( attempt >= max_attempts )); then
      echo "❌ Command failed after ${max_attempts} attempts: $*"
      return 1
    fi
    echo "   ⏳ Waiting ${delay}s for GCP IAM propagation (attempt ${attempt}/${max_attempts})..."
    sleep "${delay}"
    ((attempt++))
  done
}

# 0. Preflight Check: Verify Baseline Roles ("Service Usage Admin" & "Project IAM Admin")
echo "-> [0/5] Verifying baseline IAM permissions for '${ACTIVE_USER}' on '${PROJECT_ID}'..."
IAM_POLICY_JSON="$(gcloud projects get-iam-policy "${PROJECT_ID}" --format=json 2>/dev/null || true)"
if [[ -z "${IAM_POLICY_JSON}" ]]; then
  echo "❌ Error: Unable to read IAM policy for project '${PROJECT_ID}'."
  echo "   Ensure '${ACTIVE_USER}' has 'Project IAM Admin' (roles/resourcemanager.projectIamAdmin) and 'Service Usage Admin' (roles/serviceusage.serviceUsageAdmin)."
  exit 1
fi

MISSING_BASELINE="$(
  IAM_POLICY_JSON="${IAM_POLICY_JSON}" ACTIVE_USER="${ACTIVE_USER}" "${PYTHON_BIN}" - <<'PYEOF'
import json, os, sys
policy = json.loads(os.environ["IAM_POLICY_JSON"])
user_member = f"user:{os.environ['ACTIVE_USER'].lower()}"
held_roles = set()
for b in policy.get("bindings", []):
    members = [m.lower() for m in b.get("members", [])]
    if user_member in members:
        held_roles.add(b.get("role"))

if "roles/owner" in held_roles:
    sys.exit(0)

missing = []
if "roles/serviceusage.serviceUsageAdmin" not in held_roles and "roles/editor" not in held_roles:
    missing.append("roles/serviceusage.serviceUsageAdmin (Service Usage Admin)")
if "roles/resourcemanager.projectIamAdmin" not in held_roles:
    missing.append("roles/resourcemanager.projectIamAdmin (Project IAM Admin)")

if missing:
    print(", ".join(missing))
PYEOF
)"

if [[ -n "${MISSING_BASELINE}" ]]; then
  echo "❌ Error: '${ACTIVE_USER}' is missing prerequisite baseline role(s): ${MISSING_BASELINE}"
  exit 1
fi
echo "   ✅ Baseline roles verified (Service Usage Admin & Project IAM Admin)."

# 1. Enable Required APIs
echo "-> [1/5] Enabling required Google Cloud APIs on '${PROJECT_ID}'..."
gcloud services enable \
  aiplatform.googleapis.com \
  cloudresourcemanager.googleapis.com \
  firestore.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project="${PROJECT_ID}"

# 1b. Grant Operator Roles required by setup.sh components to ACTIVE_USER
OPERATOR_ROLES=(
  "roles/iam.serviceAccountAdmin"
  "roles/iam.serviceAccountKeyAdmin"
  "roles/datastore.owner"
)

NEW_USER_ROLE_ADDED=false
echo "-> [1/5] Ensuring '${ACTIVE_USER}' has required setup operator roles..."
for OP_ROLE in "${OPERATOR_ROLES[@]}"; do
  if ! IAM_POLICY_JSON="${IAM_POLICY_JSON}" ACTIVE_USER="${ACTIVE_USER}" OP_ROLE="${OP_ROLE}" "${PYTHON_BIN}" - <<'PYEOF'
import json, os, sys
policy = json.loads(os.environ["IAM_POLICY_JSON"])
user_member = f"user:{os.environ['ACTIVE_USER'].lower()}"
target_role = os.environ["OP_ROLE"]
for b in policy.get("bindings", []):
    if b.get("role") in (target_role, "roles/owner"):
        if user_member in [m.lower() for m in b.get("members", [])]:
            sys.exit(0)
sys.exit(1)
PYEOF
  then
    echo "   + Adding missing operator role ${OP_ROLE} to user:${ACTIVE_USER}..."
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="user:${ACTIVE_USER}" \
      --role="${OP_ROLE}" \
      --condition=None \
      --quiet >/dev/null
    NEW_USER_ROLE_ADDED=true
  else
    echo "   ✅ User already has ${OP_ROLE}"
  fi
done

if [[ "${NEW_USER_ROLE_ADDED}" == "true" ]]; then
  echo "   ⏳ Waiting 10s for newly granted operator IAM roles to propagate..."
  sleep 10
fi

# 2. Create Service Account & Bind IAM Roles
echo "-> [2/5] Ensuring Service Account '${SA_NAME}' exists..."
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  retry_with_backoff gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="Aris Smart Home Agent Service Account" \
    --description="Least-privilege runtime identity for live-smarthome-agent" \
    --project="${PROJECT_ID}"
  sleep 5
else
  echo "   ✅ Service Account '${SA_EMAIL}' already exists."
fi

ROLES=(
  "roles/aiplatform.user"
  "roles/datastore.user"
  "roles/logging.logWriter"
  "roles/monitoring.metricWriter"
  "roles/monitoring.dashboardEditor"
)

echo "-> [2/5] Binding required IAM roles to '${SA_EMAIL}'..."
for ROLE in "${ROLES[@]}"; do
  echo "   + Binding ${ROLE}"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet >/dev/null
done

# 3. Provision Named Firestore Database (if not present)
echo "-> [3/5] Checking Firestore database '${FIRESTORE_DB}' in '${PROJECT_ID}'..."
if gcloud firestore databases describe --database="${FIRESTORE_DB}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "   ✅ Firestore database '${FIRESTORE_DB}' already exists."
else
  echo "   Creating Firestore Native database '${FIRESTORE_DB}' in '${LOCATION}'..."
  retry_with_backoff gcloud firestore databases create \
    --database="${FIRESTORE_DB}" \
    --location="${LOCATION}" \
    --type=firestore-native \
    --project="${PROJECT_ID}"
  echo "   ✅ Firestore database '${FIRESTORE_DB}' created."
fi

# 4. Configure Local Credentials for the Service Account
echo "-> [4/5] Configuring runtime credentials for '${SA_EMAIL}'..."
KEY_DIR="${SCRIPT_DIR}/.credentials"
KEY_FILE="${KEY_DIR}/${SA_NAME}-key.json"
mkdir -p "${KEY_DIR}"

if [[ -f "${KEY_FILE}" ]]; then
  echo "   ✅ Existing Service Account key found at ${KEY_FILE}"
  export GOOGLE_APPLICATION_CREDENTIALS="${KEY_FILE}"
elif gcloud iam service-accounts keys create "${KEY_FILE}" \
  --iam-account="${SA_EMAIL}" \
  --project="${PROJECT_ID}" 2>/dev/null; then
  chmod 600 "${KEY_FILE}"
  export GOOGLE_APPLICATION_CREDENTIALS="${KEY_FILE}"
  echo "   ✅ Service Account key created at ${KEY_FILE}"
else
  rm -f "${KEY_FILE}"
  echo "   ℹ️ Service Account key creation restricted by org policy; configuring ADC & user runtime roles..."
  gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --member="user:${ACTIVE_USER}" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --project="${PROJECT_ID}" \
    --quiet >/dev/null
  for ROLE in "${ROLES[@]}"; do
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="user:${ACTIVE_USER}" \
      --role="${ROLE}" \
      --condition=None \
      --quiet >/dev/null
  done
  gcloud auth application-default set-quota-project "${PROJECT_ID}" --quiet >/dev/null 2>&1 || true
fi

if [[ -f "${KEY_FILE}" ]]; then
  if grep -q "^GOOGLE_APPLICATION_CREDENTIALS=" "${ENV_FILE}" 2>/dev/null; then
    sed -i "s|^GOOGLE_APPLICATION_CREDENTIALS=.*|GOOGLE_APPLICATION_CREDENTIALS=${KEY_FILE}|" "${ENV_FILE}"
  else
    printf "\nGOOGLE_APPLICATION_CREDENTIALS=%s\n" "${KEY_FILE}" >> "${ENV_FILE}"
  fi
fi

# 5. Seed initialData from static/initialize.html into Firestore (if not already seeded)
echo "-> [5/5] Seeding initialData from static/initialize.html into '${FIRESTORE_DB}' (home-users/default)..."
SCRIPT_DIR="${SCRIPT_DIR}" "${PYTHON_BIN}" - <<'PYEOF'
import os
import pathlib
import re
import sys
import time
import yaml

from google.cloud import firestore

script_dir = pathlib.Path(os.environ["SCRIPT_DIR"])
init_html_path = script_dir / "static" / "initialize.html"
project_id = os.environ["GOOGLE_CLOUD_PROJECT"]
firestore_db = os.environ.get("GOOGLE_CLOUD_FIRESTORE", "live-smartcamera")

html_text = init_html_path.read_text(encoding="utf-8")
match = re.search(r"const\s+initialData\s*=\s*(\{.*?\n    \});", html_text, re.DOTALL)
if not match:
    print("   ⚠️ Could not locate initialData in static/initialize.html", file=sys.stderr)
    sys.exit(1)

initial_data = yaml.safe_load(match.group(1))

for attempt in range(1, 7):
    try:
        db = firestore.Client(project=project_id, database=firestore_db)
        doc_ref = db.collection("home-users").document("default")
        snap = doc_ref.get()

        if snap.exists:
            devices_count = len((snap.to_dict() or {}).get("devices", {}))
            print(f"   ✅ Document 'home-users/default' already exists ({devices_count} devices). Skipping seed.")
        else:
            doc_ref.set(initial_data, merge=True)
            devices_count = len(initial_data.get("devices", {}))
            print(f"   ✅ Seeded 'home-users/default' with {devices_count} default devices from static/initialize.html.")
        break
    except Exception as exc:
        if attempt == 6:
            raise
        print(f"   ⏳ Waiting 5s for Firestore/IAM readiness (attempt {attempt}/6): {exc}")
        time.sleep(5)
PYEOF

echo "=========================================================="
echo "✅ Setup Complete!"
echo "   Firestore Reference : ${PROJECT_ID} / ${FIRESTORE_DB} (home-users/default)"
echo "   Start the server    : uv run main.py"
echo "=========================================================="
