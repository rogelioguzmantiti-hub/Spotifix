"""Rota WireGuard (servicios WireGuardTunnel$us-*) en esta PC. Sin UAC.
Uso:
  python vpn_rotate.py --status              -> WG-STATUS <ip> <pais> <ciudad>
  python vpn_rotate.py --rotate               -> WG-OK <ip> US <ciudad> | WG-FAIL <motivo>
  python vpn_rotate.py --down                 -> apaga el tunel activo
Rota round-robin entre los 6 servicios USA instalados, verificando pais==US.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time
import urllib.request as U

WGDIR = os.path.join(os.environ.get("APPDATA", ""),
                     "Spotifix", "Spotify Mobile", "Files", "wg")
STATE = os.path.join(WGDIR, "state.json")
SERVICES = ["us-nyc", "us-dal", "us-mia", "us-chi", "us-sea", "us-atl"]


def log(m):
    print(m, flush=True)


def sc(*a, timeout=60):
    try:
        r = subprocess.run(["sc.exe"] + list(a), capture_output=True, text=True,
                           timeout=timeout)
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return "ERR:%s" % e


def svc_running(name):
    out = sc("query", "WireGuardTunnel$%s" % name)
    return "RUNNING" in out


def public_ip():
    for url in ("http://ip-api.com/json/", "https://ipinfo.io/json"):
        try:
            with U.urlopen(url, timeout=15) as r:
                d = json.loads(r.read().decode())
            cc = d.get("countryCode") or d.get("country") or ""
            ip = d.get("query", d.get("ip", ""))
            if ip:
                return ip, cc, d.get("city", "")
        except Exception:
            continue
    return "", "", ""


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"idx": -1, "active": ""}


def save_state(st):
    try:
        os.makedirs(WGDIR, exist_ok=True)
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(st, f)
    except Exception:
        pass


def stop_all():
    for s in SERVICES:
        if svc_running(s):
            sc("stop", "WireGuardTunnel$%s" % s)
    time.sleep(3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--rotate", action="store_true")
    ap.add_argument("--down", action="store_true")
    a = ap.parse_args()

    if a.status:
        ip, cc, city = public_ip()
        print("WG-STATUS %s %s %s" % (ip or "?", cc or "?", city or ""))
        return 0

    if a.down:
        stop_all()
        save_state({"idx": -1, "active": ""})
        print("WG-DOWN")
        return 0

    st = load_state()
    order = list(range(len(SERVICES)))
    start = (st.get("idx", -1) + 1) % len(SERVICES)
    order = order[start:] + order[:start]
    for i in order:
        name = SERVICES[i]
        stop_all()
        log("levantando %s..." % name)
        sc("start", "WireGuardTunnel$%s" % name)
        time.sleep(10)
        ip, cc, city = public_ip()
        log("ip=%s pais=%s ciudad=%s" % (ip, cc, city))
        if cc == "US" and ip:
            save_state({"idx": i, "active": name})
            print("WG-OK %s US %s" % (ip, city or ""))
            return 0
        log("no es USA, siguiente...")
        sc("stop", "WireGuardTunnel$%s" % name)
        time.sleep(2)
    print("WG-FAIL ningun tunel dio USA")
    return 2


if __name__ == "__main__":
    sys.exit(main())
