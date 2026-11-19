#!/usr/bin/env bash
# Delete every record of a demo/test pharmacy by GPhC premises number, on production
# (hhh26-4ebd2). Lists what it finds, asks you to type the GPhC number to confirm, then
# deletes in one transaction and removes the onboarding files from Cloud Storage.
#
#   scripts/delete-demo-pharmacy/delete-demo-pharmacy.sh 9012605
#
# Needs: firebase CLI signed in, gcloud signed in, python3. Never run it on a real
# pharmacy's GPhC number: nothing here can be undone.
set -euo pipefail

GPHC="${1:-}"
if [[ ! "$GPHC" =~ ^[0-9]{7}$ ]]; then
  echo "Usage: $0 <7-digit GPhC premises number>" >&2
  exit 1
fi
PROJECT="hhh26-4ebd2"
HERE="$(cd "$(dirname "$0")" && pwd)"
GQL="$HERE/delete-demo-pharmacy.gql"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run() { # run <operation> <vars-json> <out-file>
  firebase dataconnect:execute "$GQL" "$1" --vars "$2" --service hhh-platform-service --location europe-west2 \
    --project "$PROJECT" --non-interactive < /dev/null > "$3" 2>&1
  python3 - "$3" <<'PY'
import json, sys
raw = open(sys.argv[1]).read()
start, end = raw.find('{'), raw.rfind('}')
body = json.loads(raw[start:end + 1]) if start >= 0 else {}
if body.get('errors') or 'data' not in body:
    print(raw, file=sys.stderr)
    sys.exit(1)
json.dump(body['data'], open(sys.argv[1], 'w'))
PY
}

run FindDemoPharmacy "{\"gphc\":\"$GPHC\"}" "$WORK/found.json"
ORGS=$(python3 -c "import json;d=json.load(open('$WORK/found.json'));print(json.dumps([o['id'] for o in d['organisations']]))")
REQS=$(python3 -c "import json;d=json.load(open('$WORK/found.json'));print(json.dumps([r['id'] for r in d['pharmacyOnboardingRequests']]))")
run FindDemoPharmacyLinks "{\"organisationIds\":$ORGS}" "$WORK/links.json"
STAFF=$(python3 -c "import json;d=json.load(open('$WORK/links.json'));print(json.dumps([s['uid'] for s in d['staffUsers']]))")

python3 - "$WORK/found.json" "$WORK/links.json" <<'PY'
import json, sys
found, links = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
print('Branches:', [f"{o['name']} ({o['status']}, created {o['createdAt']})" for o in found['organisations']] or 'none')
print('Onboarding requests:', [f"{r['pharmacyName']} ({r['status']}, created {r['createdAt']})" for r in found['pharmacyOnboardingRequests']] or 'none')
print('Staff logins on the branch:', [f"{s['email']} ({s['role']})" for s in links['staffUsers']] or 'none')
print('ClickUp card:', found['clickupCards'][0]['clickupTaskId'] if found['clickupCards'] else 'none', '(the task on the ClickUp board is not deleted)')
if links['patients'] or links['orders']:
    print('\nThis branch has patients or orders. The delete will be refused; remove those first.', file=sys.stderr)
    sys.exit(2)
PY

if [[ "$ORGS" == "[]" && "$REQS" == "[]" ]]; then
  echo "Nothing on the platform has GPhC $GPHC."
  exit 0
fi

read -r -p "Type the GPhC number again to delete all of this permanently: " CONFIRM
if [[ "$CONFIRM" != "$GPHC" ]]; then
  echo "Not deleted."
  exit 1
fi

run DeleteDemoPharmacy "{\"gphc\":\"$GPHC\",\"organisationIds\":$ORGS,\"requestIds\":$REQS,\"staffUids\":$STAFF}" "$WORK/deleted.json"
echo "Deleted rows:"; python3 -c "import json;d=json.load(open('$WORK/deleted.json'));[print(f'  {k}: {v}') for k,v in d.items() if v]"

# The files sit beside the filled Curaleaf form: pharmacy-onboarding/<request id>/.
for folder in $(python3 -c "import json,os;print(' '.join(sorted({os.path.dirname(r['filledFormStoragePath']) for r in json.load(open('$WORK/found.json'))['pharmacyOnboardingRequests'] if r.get('filledFormStoragePath')})))"); do
  gcloud storage rm --recursive "gs://$PROJECT.firebasestorage.app/$folder/" --project "$PROJECT" --quiet 2>/dev/null \
    && echo "Removed stored files in $folder" || echo "No stored files in $folder"
done
echo "Done. GPhC $GPHC can now go through onboarding again."
