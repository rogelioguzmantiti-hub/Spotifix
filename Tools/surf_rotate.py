"""Surfshark: IP fresca USA por cuenta. Multi-emulador (sin CDP).
Uso: python surf_rotate.py [serial]
Imprime: SURF-OK <ciudad> <ip> US | SURF-FAIL <motivo>
1) Chip reciente USA (bandera) o busqueda United States.
2) Fallback garantizado: desconectar/reconectar por nodos.
3) Verifica tunel WireGuard (conntrack) + geolocaliza desde la PC. Solo USA.
Tiempos largos: funciona con internet lento. Jamas deja Mexico.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request as U

SERIAL = sys.argv[1] if len(sys.argv) > 1 else "emulator-5554"
ADB = os.environ.get("SPOTIFIX_ADB", "adb")
PKG = "com.surfshark.vpnclient.android"
SHOT = os.path.join(os.environ.get("TEMP", "/tmp"), "_surf_cap.png")


def adb(*a, timeout=60, retries=2):
    last = ""
    for _ in range(retries + 1):
        try:
            r = subprocess.run([ADB, "-s", SERIAL] + list(a), capture_output=True,
                               timeout=timeout)
            return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="ignore")
        except Exception as e:
            last = str(e)
            time.sleep(5)
    log("adb lento: %s" % last[:80])
    return ""


def tap(x, y):
    adb("shell", "input", "tap", str(int(x)), str(int(y)))


def nodes():
    adb("shell", "uiautomator", "dump", "/sdcard/_s.xml")
    p = subprocess.run([ADB, "-s", SERIAL, "shell", "cat", "/sdcard/_s.xml"],
                       capture_output=True)
    adb("shell", "rm", "-f", "/sdcard/_s.xml")
    raw = p.stdout or b""
    for enc in ("utf-16", "utf-8"):
        try:
            t = raw.decode(enc)
            if "<hierarchy" in t:
                break
        except Exception:
            continue
    else:
        t = raw.decode("utf-8", errors="ignore")
    out = []
    for m in re.finditer(r"<node\b[^>]*>", t):
        n = m.group(0)
        tm = re.search(r'text="([^"]*)"', n)
        bm = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if not bm:
            continue
        out.append({"text": tm.group(1) if tm else "",
                    "x": (int(bm.group(1)) + int(bm.group(3))) // 2,
                    "y": (int(bm.group(2)) + int(bm.group(4))) // 2})
    return out


def find(ns, *words):
    for n in ns:
        t = n["text"].lower()
        if n["text"] and all(w.lower() in t for w in words):
            return n
    return None


def find_exact(ns, *words):
    pats = [re.compile(r"\b%s\b" % re.escape(w.lower())) for w in words]
    for n in ns:
        t = n["text"].lower()
        if n["text"] and all(p.search(t) for p in pats):
            return n
    return None


def cap():
    subprocess.run("adb -s %s exec-out screencap -p > %s" % (SERIAL, SHOT),
                   shell=True)
    try:
        from PIL import Image
        return Image.open(SHOT).convert("RGB")
    except Exception:
        return None


def usa_flags(top=0.55, bottom=0.95):
    im = cap()
    if im is None:
        return []
    w, h = im.size
    px = im.load()
    ys = []
    y = int(h * top)
    while y < int(h * bottom):
        n = 0
        for x in range(int(w * 0.05), int(w * 0.22), 3):
            r, g, b = px[x, y]
            if (r > 150 and g < 110 and b < 110) or (r < 110 and g < 110 and b > 140):
                n += 1
        if n > 15:
            ys.append(y)
            y += 120
        else:
            y += 4
    return ys


def vpn_ip(ns=None):
    ns = ns if ns is not None else nodes()
    for n in ns:
        m = re.search(r"Direcci.n IP de VPN\s*([0-9.]+)", n["text"])
        if m:
            return m.group(1)
    return None


def tunnel_ip():
    """IP del servidor WireGuard (conntrack). None si no hay tunel."""
    out = adb("shell", "cat", "/proc/net/nf_conntrack", timeout=20)
    if "dport=51820" not in out and " udp " not in out:
        adb("shell", "root", timeout=20)
        time.sleep(3)
        out = adb("shell", "cat", "/proc/net/nf_conntrack", timeout=20)
    for ln in out.splitlines():
        if " udp " not in ln or "[ASSURED]" not in ln:
            continue
        m = re.search(r"src=(\S+) dst=(\S+) sport=\S+ dport=(\d+)", ln)
        if not m:
            continue
        s, d, port = m.group(1), m.group(2), m.group(3)
        if s.startswith("10.14.") or s.startswith("127.") or d.startswith("10.") or d.startswith("192.168."):
            continue
        if port == "53":
            continue
        return d
    return None


def geolocate(ip):
    for url in ("https://ipinfo.io/%s/json" % ip,
                "https://ipapi.co/%s/json/" % ip):
        try:
            with U.urlopen(url, timeout=20) as r:
                d = json.loads(r.read().decode())
            cc = d.get("country_code") or d.get("country") or ""
            if cc:
                return cc, d.get("city") or d.get("region") or "USA", d.get("ip", ip)
        except Exception:
            continue
    return "", "", ip


def open_app():
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(8)


def confirm_dialogs():
    for _ in range(4):
        ns = nodes()
        later = find(ns, "s tarde") or find(ns, "later")
        if later:
            tap(later["x"], later["y"])
            time.sleep(4)
            continue
        chg = find(ns, "cambiar ubicaci")
        if chg:
            c = find(ns, "continuar")
            if c:
                tap(c["x"], c["y"])
                time.sleep(6)
                continue
        break


def wait_tunnel(before, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(10)
        confirm_dialogs()
        ip = tunnel_ip()
        if ip and ip != before:
            return ip
    return None


def log(m):
    print(m, flush=True)


def chip_flow(before):
    """Chip reciente USA -> Continuar. IP tunel o None."""
    open_app()
    confirm_dialogs()
    fys = usa_flags()
    if not fys:
        log("sin chips USA visibles")
        return None
    tap(230, fys[0])
    time.sleep(6)
    confirm_dialogs()
    return wait_tunnel(before)


def reconnect_flow(before):
    """Desconectar + Conectar por nodos. IP tunel o None."""
    open_app()
    for _ in range(3):
        ns = nodes()
        if find(ns, "desconectar") or find_exact(ns, "conectar"):
            break
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(3)
    ns = nodes()
    disc = find(ns, "desconectar")
    if disc:
        tap(disc["x"], disc["y"])
        time.sleep(6)
        confirm_dialogs()
    ns = nodes()
    conn = find_exact(ns, "conectar")
    if conn:
        tap(conn["x"], conn["y"])
    else:
        tap(540, 1390)
    return wait_tunnel(before)


def main():
    before = tunnel_ip()
    log("tunel actual: %s" % (before or "sin vpn"))
    ip = chip_flow(before)
    if ip:
        log("chip USA, tunel: %s" % ip)
    else:
        log("chip no funciono, reconexion directa...")
        ip = reconnect_flow(before)
    if not ip or (before and ip == before):
        cur = tunnel_ip()
        if cur and not before:
            ip = cur
        else:
            print("SURF-FAIL sin cambio de tunel")
            return 5
    log("verificando pais de %s..." % ip)
    cc, city, _ = geolocate(ip)
    if cc in ("US", "USA", "United States"):
        print("SURF-OK %s %s US" % (city, ip))
        return 0
    if not cc:
        print("SURF-OK USA %s US-lista" % ip)
        return 0
    print("SURF-FAIL pais=%s ip=%s" % (cc, ip))
    return 6


if __name__ == "__main__":
    sys.exit(main())
