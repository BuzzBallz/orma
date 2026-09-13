#!/usr/bin/env bash
#
# Bring the whole demonstration up, and say plainly whether it is presentable.
#
# WHY A SCRIPT. Starting this by hand is three commands, two of which fail silently in
# ways that only show up on stage: a backend left running from yesterday holds port 8787
# so the new one dies on EADDRINUSE, and a facility whose window has expired serves
# negative countdowns that look like a bug. Both happened during the build. This checks
# for them and refuses to claim success when it should not.
#
# Run: bash start-demo.sh
set -uo pipefail
cd "$(dirname "$0")"

GREEN=$'\033[32m'; RED=$'\033[31m'; AMBER=$'\033[33m'; OFF=$'\033[0m'
ok()   { echo "  ${GREEN}ok${OFF}    $*"; }
warn() { echo "  ${AMBER}note${OFF}  $*"; }
bad()  { echo "  ${RED}STOP${OFF}  $*"; }

echo ""
echo "  Orma, bringing the demonstration up"
echo ""

# --- memory ------------------------------------------------------------------
# The backend was reaped three times during the build, always under 1 GB free. It is the
# newest process, so it is first in line when Windows starts reclaiming.
FREE=$(powershell -NoProfile -Command '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)' 2>/dev/null | tr -d '\r')
if [ -n "$FREE" ]; then
  if awk "BEGIN{exit !($FREE < 2.5)}"; then
    warn "only ${FREE} GB of memory free. The backend was killed three times below 1 GB."
    warn "Close Chrome tabs, Discord and Edge, or reboot, before you present."
  else
    ok "${FREE} GB memory free"
  fi
fi

# --- stale processes ---------------------------------------------------------
# A backend from an earlier run holds the port and the new one dies on EADDRINUSE, which
# reads as "the code is broken" rather than "something else is already listening".
STALE=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*src/index.mjs*' }).ProcessId" 2>/dev/null | tr -d '\r' | grep -c '[0-9]' || true)
if [ "${STALE:-0}" -gt 0 ]; then
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*src/index.mjs*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  ok "stopped ${STALE} backend(s) left over from an earlier run"
  sleep 2
fi

# --- backend -----------------------------------------------------------------
echo ""
echo "  starting the reader"
LOG_PRETTY=1 nohup node src/index.mjs > .demo-backend.log 2>&1 &
for _ in $(seq 1 40); do
  curl -s -m 2 -o /dev/null http://localhost:8787/api/health 2>/dev/null && break
  sleep 2
done
if ! curl -s -m 3 -o /dev/null http://localhost:8787/api/health 2>/dev/null; then
  bad "the backend did not come up. Last lines:"
  tail -12 .demo-backend.log | sed 's/^/        /'
  exit 1
fi
ok "backend on :8787"

# --- the facilities, and whether their phases still work ---------------------
echo ""
node src/dev/check-demo-ready.mjs
FACILITIES=$?

# --- frontend ----------------------------------------------------------------
echo ""
echo "  starting the interface"
( cd app && nohup pnpm dev --port 5173 > ../.demo-frontend.log 2>&1 & )
for _ in $(seq 1 30); do
  curl -s -m 2 -o /dev/null http://localhost:5173/ 2>/dev/null && break
  sleep 2
done
if curl -s -m 3 -o /dev/null http://localhost:5173/ 2>/dev/null; then
  ok "interface on :5173"
else
  bad "the interface did not come up. Last lines:"
  tail -10 .demo-frontend.log | sed 's/^/        /'
fi

echo ""
echo "  ------------------------------------------------------------"
echo "  interface     http://localhost:5173"
echo "  deck          deck/index.html          S notes, T timer, P print"
echo "  documentation https://ormaprotocol.mintlify.site/"
echo "  run of show   docs/45-RUNSHEET.md"
echo "  hard questions docs/46-QA-CAVEATS.md"
echo ""
[ "${FACILITIES:-0}" -eq 2 ] && echo "  ${RED}A facility needs rebaking before you present. See above.${OFF}" && echo ""
exit 0
