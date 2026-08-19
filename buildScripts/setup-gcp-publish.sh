#!/bin/bash
set -e

# One-time setup so this repository's Data Sync workflow can publish the working set.
#
# Reuses the existing Workload Identity pool; adds one provider, one service account and one binding.
# Idempotent — every step tolerates already existing.
#
#   Run once:  bash buildScripts/setup-gcp-publish.sh
#
# Rationale, topology and the values below live with the deployment configuration, not here.

# Deployment identifiers come from this repository's ACTIONS VARIABLES, fetched here.
#
# They are not secrets, but they do not belong in a public tree either — together they map the whole
# publish path. Repository variables sit in the middle, which is exactly right: visible to anyone with
# repository access, invisible to the world, versioned nowhere, and readable by both this script and
# the workflow without anyone exporting anything.
#
# Env overrides are honoured so the script still runs against a different project without edits.
read_var() {
    local name="$1"
    local value="${!name:-}"

    [ -n "$value" ] || value="$(gh variable get "$name" -R "${REPO_NAME}" 2>/dev/null || true)"
    [ -n "$value" ] || { echo "Missing: $name. Set it as a repository variable on ${REPO_NAME}, or export it." >&2; exit 1; }
    echo "$value"
}

REPO_NAME="neomjs/devindex"

PROJECT_ID="$(read_var DEVINDEX_GCP_PROJECT_ID)"
PROJECT_NUMBER="$(read_var DEVINDEX_GCP_PROJECT_NUMBER)"

# Objects must live under the prefix the content plane mounts; see the deployment repo.
BUCKET="$(read_var DEVINDEX_GCP_BUCKET)"
PREFIX="${DEVINDEX_GCP_PREFIX:-dist/devindex}"
WIF_POOL="$(read_var DEVINDEX_GCP_WIF_POOL)"

# A dedicated identity, scoped to object writes on one prefix and nothing else.
SA_NAME="devindex-publish-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# A dedicated provider in the existing pool. Additive: no existing provider is modified.
PROVIDER="devindex-provider"
WIF="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${PROVIDER}"

gcloud config set project $PROJECT_ID --quiet

echo "Creating a devindex-scoped WIF provider (additive)..."
gcloud iam workload-identity-pools providers create-oidc $PROVIDER \
    --location="global" \
    --workload-identity-pool="${WIF_POOL}" \
    --display-name="DevIndex Publish Provider" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '${REPO_NAME}'" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --quiet || true

echo "Creating the publish service account..."
gcloud iam service-accounts create $SA_NAME \
    --description="Publishes the DevIndex working set to the content plane" \
    --display-name="DevIndex Publish SA" \
    --quiet || true

# Object-level, on ONE bucket, and nothing at project level. objectAdmin rather than objectCreator
# because the publish overwrites the same four objects every run; objectCreator cannot replace.
echo "Granting object write on gs://${BUCKET} only..."
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/storage.objectAdmin" \
    --quiet

# Bindings are per-repository. This is what lets THIS repository's runner impersonate this account.
echo "Allowing ${REPO_NAME} to impersonate it via Workload Identity..."
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${REPO_NAME}" \
    --quiet

echo "Writing repository secrets and variables..."
gh secret set WIF_PROVIDER      -b "${WIF}"                  -R ${REPO_NAME}
gh secret set PUBLISH_SA_EMAIL  -b "${SA_EMAIL}"             -R ${REPO_NAME}
gh variable set DEVINDEX_PUBLISH_BUCKET -b "gs://${BUCKET}/${PREFIX}" -R ${REPO_NAME}

echo ""
echo "Done. Neither value is a credential: WIF_PROVIDER is a resource path and PUBLISH_SA_EMAIL is an"
echo "address. Nothing secret is stored — the runner mints a short-lived token per run."
echo ""
echo "Next: dispatch 'DevIndex Data Sync' with run_collection=true. If it publishes, add the schedule."
