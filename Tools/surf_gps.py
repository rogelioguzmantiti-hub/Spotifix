"""Surfshark GPS: verifica override GPS activo; si esta apagado lo enciende.
Uso: python surf_gps.py [serial]
Imprime: GPS-OK <detalle>  o  GPS-FAIL <motivo>
"""
import os
import re
import subprocess
import sys
import time

SERIAL = sys.argv[1] if len(sys.argv) > 1 else "emulator-5554"
ADB = os.environ.get("SPOTIFIX_ADB", "adb")
PKG = "com.surfshark.vpnclient.android"


def adb(*a, timeout=30):
    r = subprocess.run([ADB, "-s", SERIAL] + list(a), capture_output=True,
                       timeout=timeout)
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="ignore")


def tap(x, y):
    adb("shell", "input", "tap", str(int(x)), str(int(y)))


def tapf(fx, fy):
    w, h = size()
    tap(w * fx, h * fy)


def size():
    m = re.search(r"(\d+)x(\d+)", adb("shell", "wm", "size"))
    return (int(m.group(1)), int(m.group(2))) if m else (1080, 2400)


def nodes():
    adb("shell", "uiautomator", "dump", "/sdcard/_g.xml")
    p = subprocess.run([ADB, "-s", SERIAL, "shell", "cat", "/sdcard/_g.xml"],
                       capture_output=True)
    adb("shell", "rm", "-f", "/sdcard/_g.xml")
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
        cm = re.search(r'class="([^"]*)"', n)
        bm = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        km = re.search(r'checked="([^"]*)"', n)
        if not bm:
            continue
        out.append({"text": tm.group(1) if tm else "",
                    "cls": cm.group(1).split(".")[-1] if cm else "",
                    "checked": km.group(1) if km else None,
                    "x": (int(bm.group(1)) + int(bm.group(3))) // 2,
                    "y": (int(bm.group(2)) + int(bm.group(4))) // 2})
    return out


def find_text(ns, *words):
    for n in ns:
        t = n["text"].lower()
        if n["text"] and all(w.lower() in t for w in words):
            return n
    return None


def log(m):
    print(m, flush=True)


def adb_checks(fix=True):
    ok = True
    dev = adb("shell", "settings", "get", "global", "development_settings_enabled").strip()
    if dev != "1":
        log("dev options apagadas, encendiendo...")
        if fix:
            adb("shell", "settings", "put", "global", "development_settings_enabled", "1")
        else:
            return False
    mock = adb("shell", "settings", "get", "secure", "mock_location").strip()
    if PKG not in mock:
        log("mock app no es surfshark, corrigiendo...")
        if fix:
            adb("shell", "settings", "put", "secure", "mock_location", PKG)
        else:
            return False
    ao = adb("shell", "appops", "get", PKG, "android:mock_location")
    if "allow" not in ao.lower():
        log("appops mock denegado, permitiendo...")
        if fix:
            adb("shell", "appops", "set", PKG, "android:mock_location", "allow")
        else:
            return False
    mock = adb("shell", "settings", "get", "secure", "mock_location").strip()
    ao = adb("shell", "appops", "get", PKG, "android:mock_location")
    ok = (PKG in mock) and ("allow" in ao.lower())
    log("adb: mock=%s appops=%s" % (mock, "allow" if "allow" in ao.lower() else ao.strip()[:40]))
    return ok


def tap_text(words, timeout_s=20, scrolls=0):
    """Toca el nodo cuyo texto contenga words. Devuelve el nodo o None."""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        ns = nodes()
        hit = find_text(ns, *words)
        if hit:
            tap(hit["x"], hit["y"])
            return hit
        w, h = size()
        adb("shell", "input", "swipe", str(w // 2), str(int(h * 0.7)),
            str(w // 2), str(int(h * 0.3)), "500")
        time.sleep(3)
    return None


def main():
    if not adb_checks(fix=True):
        print("GPS-FAIL permisos adb")
        return 6
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(8)
    # ajustes: icono persona o tab Configuracion
    ns = nodes()
    person = find_text(ns, "configuraci")
    if person and person["y"] > size()[1] * 0.8:
        pass  # ya estamos en ajustes (tab visible)
    else:
        tapf(0.116, 0.065)
        time.sleep(5)
    hit = tap_text(["configuraci", "vpn"], timeout_s=30)
    if not hit:
        # quiza ya estamos en ajustes raiz: buscar item VPN
        ns = nodes()
        hit = find_text(ns, "vpn")
        if hit:
            tap(hit["x"], hit["y"])
            time.sleep(5)
        else:
            print("GPS-FAIL no se llego a Configuracion de VPN")
            return 10
    adv = tap_text(["configuraci", "avanzada"], timeout_s=30)
    if not adv:
        print("GPS-FAIL no se encontro Configuracion avanzada")
        return 11
    # buscar toggle Override GPS (scroll si hace falta)
    for _ in range(8):
        ns = nodes()
        title = find_text(ns, "override", "gps")
        if title:
            sw = None
            best = 1e9
            for n in ns:
                if n["cls"] in ("CheckBox", "Switch") and n.get("checked") in ("true", "false"):
                    dy = abs(n["y"] - title["y"])
                    if dy < best:
                        best = dy
                        sw = n
            if not sw:
                # reintentar dump (a veces tarda)
                time.sleep(3)
                continue
            if sw.get("checked") == "true":
                print("GPS-OK ya activo (adb + toggle)")
                return 0
            tap(sw["x"], sw["y"])
            time.sleep(3)
            ns2 = nodes()
            title2 = find_text(ns2, "override", "gps")
            refy = title2["y"] if title2 else title["y"]
            for n in ns2:
                if n["cls"] in ("CheckBox", "Switch") and abs(n["y"] - refy) < 150:
                    if n.get("checked") == "true":
                        print("GPS-OK activado ahora (adb + toggle)")
                        return 0
            print("GPS-FAIL toggle no confirma")
            return 7
        # scroll buscar
        w, h = size()
        adb("shell", "input", "swipe", str(w // 2), str(int(h * 0.7)),
            str(w // 2), str(int(h * 0.3)), "500")
        time.sleep(3)
    print("GPS-FAIL fila Override GPS no encontrada")
    return 9


if __name__ == "__main__":
    sys.exit(main())
