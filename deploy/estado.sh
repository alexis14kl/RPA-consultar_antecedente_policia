#!/usr/bin/env bash
# Dashboard de una pasada: servicios, pool, IP del proxy, última rotación,
# captchas recientes, túnel público y RAM. Para saber al toque si está sano/rotando.
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
TUNNEL_URL="${TUNNEL_URL:-https://localhostsssssssssssssssss.alexis-madrigal.com}"

echo "════════════════ ESTADO RPA ════════════════"
for s in rpa-xvfb rpa-chrome rpa-server rpa-proxy-watchdog; do
  a=$(systemctl is-active "$s" 2>/dev/null)
  [ "$a" = active ] && ic="🟢" || ic="🔴"
  printf "  %s %-22s %s\n" "$ic" "$s" "$a"
done

H=$(curl -s --max-time 5 http://127.0.0.1:4321/health 2>/dev/null)
pool=$(echo "$H" | grep -oE '"pool":[0-9]+' | cut -d: -f2)
tgt=$(echo "$H"  | grep -oE '"pool_target":[0-9]+' | cut -d: -f2)
esp=$(echo "$H"  | grep -oE '"esperando":[0-9]+' | cut -d: -f2)
act=$(echo "$H"  | grep -oE '"activas":[0-9]+' | cut -d: -f2)
echo "  ── pool: ${pool:-?}/${tgt:-?}   activas: ${act:-?}   esperando: ${esp:-?}"

IP=$(timeout 15 node proxy_ctl.cjs status 2>/dev/null)
echo "  ── proxy IP actual: ${IP:-?}"

ROT=$(journalctl -u rpa-proxy-watchdog --no-pager --since "-2h" 2>/dev/null | grep "nuevo proxy" | tail -1 | sed -E 's/.*(Jul[^]]*hiofkusp).*IP: /… IP: /')
echo "  ── última rotación (2h): ${ROT:-ninguna}"

OK=$(journalctl -u rpa-server --no-pager --since "-5min" 2>/dev/null | grep -c "Buster resolvió")
BL=$(journalctl -u rpa-server --no-pager --since "-5min" 2>/dev/null | grep -c "Audio bloqueado")
echo "  ── captchas (5min): ✅ ${OK} resueltos   🚫 ${BL} bloqueados"

TU=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$TUNNEL_URL/health" 2>/dev/null)
[ "$TU" = 200 ] && echo "  ── túnel público: 🟢 HTTP $TU" || echo "  ── túnel público: 🔴 HTTP ${TU:-timeout}"

echo "  ── $(free -h | awk 'NR==2{print "RAM: usada "$3" / disponible "$7}')"
echo "─────────────────────────────────────────────"
if [ "${pool:-0}" -ge 1 ] && [ "$TU" = 200 ]; then
  echo "  ✅ TODO OK — el RPA está consultando"
else
  echo "  ⚠️  ALGO ANDA MAL (pool bajo o túnel caído)"
  echo "     → recuperar: bash deploy/levantar.sh"
fi
