#!/usr/bin/env bash
# server-setup.sh — prepare /home/botuser/bot-v3 on the droplet. Run as root:
#     bash /home/botuser/bot-v3/server-setup.sh
# Safe to run more than once. Installs the service but does NOT start it.
set -uo pipefail
D=/home/botuser/bot-v3
ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; FAILED=1; }
FAILED=0
cd "$D" || { echo "no $D"; exit 1; }

echo "1. files"
need="allowance-probe.js config.js controller-check.js pool-resolve.js rug-check.js screen-token.js source-gate.js swap-legs.js tenderly-bundle-v3.js tenderly-bundle-v4.js tenderly-client.js transfer-audit.js wallet-round-trip.js watch-launches.js recheck-source.js safe-json.js template-match.js known-templates.json gate0-check.js package.json token-screener-v3.service fixtures/moo-daeng.sol"
for f in $need; do [ -s "$f" ] && ok "$f" || bad "$f missing or empty"; done
[ -s .env ] && ok ".env present" || bad ".env missing (scp .env separately — it is a hidden file)"
[ -s launches.jsonl ] && ok "launches.jsonl: $(wc -l < launches.jsonl) earlier records" || echo "  note  no launches.jsonl — starts a fresh history"
grep -q "allowanceProbe" screen-token.js && ok "screen-token.js has Gate 5c" || bad "screen-token.js is an old copy (no Gate 5c)"
grep -q "hoistBalanceOverrides" tenderly-client.js && ok "tenderly-client.js has the 12 Oct Tenderly fix" || bad "tenderly-client.js is an old copy"
grep -q "detectFile" watch-launches.js && ok "watch-launches.js saves detections.jsonl + screens/ (13 Oct)" || bad "watch-launches.js is an old copy (no full-data saving)"
grep -q "checkSourceWait" watch-launches.js && ok "watch-launches.js has the Gate 0 source re-check list (16 Oct)" || bad "watch-launches.js is an old copy (no source re-check list)"
[ "$FAILED" = 0 ] || { echo "stopping: fix the upload first"; exit 1; }

echo "2. .env for a server"
sed -i 's/^TENDERLY_DEBUG=/#TENDERLY_DEBUG=/; s/^VERBOSE=/#VERBOSE=/; s/^SCREEN_DEBUG=/#SCREEN_DEBUG=/' .env
ok "TENDERLY_DEBUG / VERBOSE / SCREEN_DEBUG commented out (debug dumps can reach 40 MB each)"
for k in TENDERLY_ACCESS_KEY TENDERLY_ACCOUNT_SLUG TENDERLY_PROJECT_SLUG BLOCKSCOUT_API_KEY; do
  grep -q "^$k=." .env && ok "$k set" || bad "$k missing from .env"
done
if grep -Eiq '^(PRIVATE_KEY|MNEMONIC|SEED|.*_PRIVATE_KEY)=.' .env; then
  echo "  WARN  .env contains a private-key/seed entry. None of these tools need one — remove it from the server copy."
fi
chmod 600 .env

echo "3. node and packages"
NV=$(node -v 2>/dev/null | sed 's/v//; s/\..*//')
[ -n "$NV" ] && [ "$NV" -ge 18 ] && ok "node $(node -v)" || bad "node 18+ needed (have $(node -v 2>/dev/null))"
mkdir -p logs screens
chown -R botuser:botuser "$D"
sudo -u botuser npm install --omit=dev --no-audit --no-fund >/tmp/v3-npm.log 2>&1 && ok "npm install (as botuser)" || { bad "npm install failed — see /tmp/v3-npm.log"; exit 1; }
sudo -u botuser node -e "const e=require('ethers'); if(!e.providers) process.exit(1)" && ok "ethers v5 API present" || bad "wrong ethers version (must be 5.x — never run npm audit fix --force)"

echo "4. offline tests (no network)"
for t in test-*.js; do
  out=$(sudo -u botuser timeout 180 node "$t" 2>&1); code=$?
  last=$(echo "$out" | tail -1)
  [ $code = 0 ] && ok "$t — $last" || { bad "$t — $last"; echo "$out" | grep -E "FAIL" | head -5; }
done

echo "5. network from this droplet"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' https://rpc.mainnet.chain.robinhood.com)
[ "$code" = 200 ] && ok "Robinhood RPC: HTTP 200" || bad "Robinhood RPC: HTTP $code"
KEY=$(grep '^BLOCKSCOUT_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
code=$(curl -s -o /dev/null -w "%{http_code}" "https://api.blockscout.com/4663/api/v2/smart-contracts/0x66A844fcbf4705Dbde3c97394d5a4C9822E8F35b?apikey=$KEY")
[ "$code" = 200 ] && ok "Blockscout official API (key): HTTP 200" || bad "Blockscout official API: HTTP $code (Gate 0 needs this)"
code=$(curl -s -o /dev/null -w "%{http_code}" https://api.tenderly.co/)
[ "$code" != 000 ] && ok "Tenderly reachable (HTTP $code)" || bad "Tenderly unreachable"

echo "6. systemd service (installed, enabled, NOT started)"
cp token-screener-v3.service /etc/systemd/system/token-screener-v3.service
systemctl daemon-reload
systemctl enable token-screener-v3 >/dev/null 2>&1 && ok "token-screener-v3 enabled (starts on reboot)" || bad "could not enable the service"

echo "7. capacity"
free -h | sed 's/^/        /'
for s in token-screener token-screener-v2 token-screener-v3; do echo "        $s: $(systemctl is-active $s 2>/dev/null)"; done

echo
[ "$FAILED" = 0 ] && echo "ALL GOOD. Next: the live smoke test, then: systemctl start token-screener-v3" || echo "SOMETHING FAILED — paste this output to Claude before starting the service."
