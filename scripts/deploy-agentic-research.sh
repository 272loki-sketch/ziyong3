#!/usr/bin/env bash
# Explicit authorized deployment: immutable code/static directory, original private data checkout untouched.
set -euo pipefail
if [[ ${1:-} != --apply ]]; then
  echo 'Usage: sudo bash scripts/deploy-agentic-research.sh --apply'
  echo 'Required: CODE_DIR=/absolute/clean/PR3-checkout DATA_DIR=/original/data/checkout'
  echo 'Optional: SERVICE=liyuan.service NODE=/opt/node22/bin/node RELEASE_ROOT=/root BACKUP_ROOT=/root/liyuan-agentic-backups'
  echo 'Requires writable /etc/systemd/system. Does not merge, edit local, change keys, or enable search permissions.'
  exit 0
fi
: "${CODE_DIR:?Set the accepted PR3 code checkout}" "${DATA_DIR:?Set the existing private data working directory}"
SERVICE=${SERVICE:-liyuan.service}; NODE=${NODE:-/opt/node22/bin/node}; RELEASE_ROOT=${RELEASE_ROOT:-/root}; BACKUP_ROOT=${BACKUP_ROOT:-/root/liyuan-agentic-backups}
for value in "$CODE_DIR" "$DATA_DIR" "$NODE" "$RELEASE_ROOT" "$BACKUP_ROOT"; do
  [[ $value == /* && $value != *$'\n'* && $value != *' '* && $value != *'"'* ]] || { echo 'Use absolute unambiguous paths'; exit 1; }
done
[[ $SERVICE =~ ^[a-zA-Z0-9_.@-]+\.service$ && $EUID -eq 0 ]] || { echo 'Root and explicit service name required'; exit 1; }
[[ -w /etc/systemd/system ]] || { echo 'BLOCKED: systemd directory is read-only; no service stopped'; exit 1; }
[[ $(git -C "$CODE_DIR" branch --show-current) == feat/agentic-research-blueprint ]] || { echo 'Not PR3 branch'; exit 1; }
git -C "$CODE_DIR" diff --quiet; git -C "$CODE_DIR" diff --cached --quiet
[[ -f "$CODE_DIR/web/dist/index.html" && -d "$CODE_DIR/node_modules" ]] || { echo 'Build/install the accepted candidate first'; exit 1; }
REV=$(git -C "$CODE_DIR" rev-parse HEAD); RELEASE="$RELEASE_ROOT/liyuan-agentic-${REV:0:12}"; DROP=/etc/systemd/system/$SERVICE.d/90-agentic-research-code.conf
[[ ! -e $DROP && ! -e $RELEASE ]] || { echo 'Existing release/override; refuse to overwrite operator state'; exit 1; }
# Read only safe state. A WS handshake is not a generation request.
"$NODE" --input-type=module - "$CODE_DIR" <<'JS'
import {createRequire} from 'node:module';const require=createRequire(process.argv[2]+'/package.json');const WS=require('ws');
const w=new WS('ws://127.0.0.1:7620/ws');let story,assistant;
const idle=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{w.terminate();reject(Error('WS state timeout'))},5000);
w.on('message',raw=>{const j=JSON.parse(String(raw));if(j.type==='hello')story=!j.streaming&&!j.settling;if(j.type==='assistant_hello')assistant=!j.busy;if(story!==undefined&&assistant!==undefined){clearTimeout(timer);w.close();resolve(story&&assistant)}});w.on('error',()=>{clearTimeout(timer);reject(Error('WS unavailable'))})});if(!idle)throw Error('Story/assistant not idle');
for(const path of ['/api/outline/corpus','/api/outline/research/search/schedule','/api/npc-parallel/status','/api/veridis-rewrite/status']){
 const r=await fetch('http://127.0.0.1:7620'+path);if(!r.ok)throw Error('Cannot confirm idle');const j=await r.json();
 if(j.busy===true||j.running===true||Array.isArray(j.running)&&j.running.length||j.documents?.some(d=>['pending','cleaning','mapping','reducing','extracting'].includes(d.status)))throw Error('Service is busy');
}
JS
mkdir -p "$BACKUP_ROOT"; chmod 700 "$BACKUP_ROOT"
STAMP=$(date +%Y%m%d-%H%M%S)
tar --acls --xattrs -czf "$BACKUP_ROOT/predeploy-$STAMP.tar.gz" --exclude='./.git' --exclude='./node_modules' --exclude='./web/node_modules' -C "$DATA_DIR" .
chmod 600 "$BACKUP_ROOT/predeploy-$STAMP.tar.gz"
mkdir "$RELEASE"; git -C "$CODE_DIR" archive HEAD | tar -x -C "$RELEASE"; cp -a "$CODE_DIR/node_modules" "$RELEASE/node_modules"
USER_NAME=$(systemctl show "$SERVICE" -p User --value); USER_NAME=${USER_NAME:-root}; chown -R "$USER_NAME" "$RELEASE"
mkdir -p "$(dirname "$DROP")"
cat > "$DROP" <<UNIT
[Service]
ExecStart=
ExecStart=$NODE $RELEASE/server/main.ts
WorkingDirectory=$DATA_DIR
Environment=LIYUAN_WEB_DIST_DIR=$RELEASE/web/dist
Environment=LIYUAN_CODE_REVISION=$REV
UNIT
rollback() { rm -f "$DROP"; systemctl daemon-reload; systemctl restart "$SERVICE"; echo 'Rolled back only the code override; private data retained'; }
trap rollback ERR
systemctl daemon-reload; systemctl restart "$SERVICE"
"$NODE" --input-type=module - "$REV" <<'JS'
const expected=process.argv[2];let ready=false;for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:7620/healthz');const j=await r.json();if(j.ok&&j.codeRevision===expected){ready=true;console.log(JSON.stringify({ok:true,version:j.version,codeRevision:j.codeRevision}));break}}catch{}await new Promise(r=>setTimeout(r,1000))}if(!ready)process.exit(1);
JS
trap - ERR
echo "Code switched. Backup: $BACKUP_ROOT/predeploy-$STAMP.tar.gz"
echo 'Now validate WS/static/SW/private hash + permissions. Model metadata append is not story rewriting.'
echo "Rollback: remove only $DROP, daemon-reload and restart $SERVICE (never restore over new user stories)."
