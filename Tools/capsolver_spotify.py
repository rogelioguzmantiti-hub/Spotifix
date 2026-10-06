import json, sys, time, subprocess, urllib.request as U, re
SERIAL = sys.argv[1] if len(sys.argv) > 1 else "emulator-5554"
WANT = "challenge.spotify.com"
def adb(*a):
    r = subprocess.run(["adb", "-s", SERIAL] + list(a), capture_output=True, timeout=30, text=True)
    return (r.stdout or "") + (r.stderr or "")
def targets():
    try:
        subprocess.run(["adb", "-s", SERIAL, "forward", "tcp:9222", "localabstract:chrome_devtools_remote"], capture_output=True, timeout=15)
    except Exception:
        pass
    time.sleep(1)
    for port in (9222, 9223):
        try:
            with U.urlopen("http://127.0.0.1:%d/json/list" % port, timeout=5) as r:
                return json.loads(r.read().decode())
        except Exception:
            continue
    return []
def dump_nodes():
    adb("shell", "uiautomator", "dump", "/sdcard/_cap.xml")
    raw = adb("shell", "cat", "/sdcard/_cap.xml")
    adb("shell", "rm", "-f", "/sdcard/_cap.xml")
    out = []
    for m in re.finditer(r"<node\b[^>]*>", raw):
        n = m.group(0)
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if not b:
            continue
        x = (int(b.group(1)) + int(b.group(3))) // 2
        y = (int(b.group(2)) + int(b.group(4))) // 2
        t = re.search(r'text="([^"]*)"', n)
        out.append((t.group(1) if t else "", x, y))
    return out
tg = [t for t in targets() if WANT in t.get("url", "")]
if not tg:
    print("NOCAPTCHA: no hay challenge abierto"); raise SystemExit(20)
print("PAGE:", tg[0]["url"][:90])
nodes = dump_nodes()
btn = [n for n in nodes if n[0].strip().lower() in ("continuar", "continue")]
if btn:
    print("BTN:", btn[0])
# 1) tap real en el checkbox (nativo, IP de tu VPN)
print("TAP checkbox nativo...")
adb("shell", "input", "tap", "540", "888")
for i in range(6):
    time.sleep(5)
    n2 = dump_nodes()
    txt = " ".join(t for t, _, _ in n2)
    if "Something went wrong" in txt or "Se ha producido un error" in txt or "Try again" in txt or "Vuelve a intentarlo" in txt:
        print("FAIL: backend rechazo (sesion quemada)"); raise SystemExit(21)
    if "Continuar" in txt or "Continue" in txt:
        b = [n for n in n2 if n[0].strip().lower() in ("continuar", "continue")]
        if b:
            print("TAP Continuar en", b[0][1], b[0][2])
            adb("shell", "input", "tap", str(b[0][1]), str(b[0][2]))
            time.sleep(8)
            n3 = dump_nodes()
            t3 = " ".join(t for t, _, _ in n3)
            if "challenge.spotify.com" not in t3 and ("Something went wrong" not in t3 and "Se ha producido" not in t3):
                print("OK: reto superado, CustomTab cerrado o avanzado"); raise SystemExit(0)
            if "Something went wrong" in t3 or "Se ha producido un error" in t3:
                print("FAIL: token nativo rechazado"); raise SystemExit(22)
            print("RETRY-CLICK")
            b2 = [n for n in n3 if n[0].strip().lower() in ("continuar", "continue")]
            if b2:
                adb("shell", "input", "tap", str(b2[0][1]), str(b2[0][2]))
                time.sleep(8)
            print("DONE-CLICK2"); raise SystemExit(0)
print("TIMEOUT esperando checkbox")
raise SystemExit(23)
