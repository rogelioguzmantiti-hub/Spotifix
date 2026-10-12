"""Registro de Spotify en Brave local (portable a cualquier PC).
Uso:
  python spotify-brave.py --email E --password P [--dob YYYY-MM-DD | --random-dob]
                          [--gender Man|Woman|random] [--profile auto|NOMBRE]
                          [--name NOMBRE] [--headless]
- Usa los perfiles Brave de LA PC donde corre (%LOCALAPPDATA%\\BraveSoftware).
- Rota perfiles (1 cuenta por perfil) con estado en %APPDATA%\\Spotifix.
- Resuelve reCAPTCHA con CapSolver (key de settings.json) si aparece.
"""
import argparse
import json
import os
import random
import sys
import time
import urllib.request as U

APPDATA = os.environ.get("APPDATA", "")
LOCALAPPDATA = os.environ.get("LOCALAPPDATA", "")
STATE = os.path.join(APPDATA, "Spotifix", "Spotify Mobile", "Files", "brave_profiles.json")
SETTINGS = os.path.join(APPDATA, "Spotifix", "Spotify Mobile", "Files", "settings.json")


def log(m):
    print(m, flush=True)


def brave_paths():
    cands = [
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        os.path.join(LOCALAPPDATA, r"BraveSoftware\Brave-Browser\Application\brave.exe"),
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def user_data_dir():
    d = os.path.join(LOCALAPPDATA, r"BraveSoftware\Brave-Browser\User Data")
    return d if os.path.isdir(d) else None


def profile_locked(udd, name):
    for lock in ("SingletonSocket", "SingletonLock", "lockfile", "SingletonCookie"):
        try:
            if os.path.exists(os.path.join(udd, name, lock)):
                return True
        except Exception:
            pass
    return False

def list_profiles(udd):
    out = []
    try:
        for name in sorted(os.listdir(udd)):
            if name == "Default" or name.startswith("Profile"):
                out.append(name)
    except Exception:
        pass
    return out

def free_profiles(udd, used):
    return [pr for pr in list_profiles(udd)
            if pr not in used and not profile_locked(udd, pr)]


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"used": []}


def save_state(st):
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(st, f)
    except Exception:
        pass


def capsolver_key():
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            return json.load(f).get("apiKey", "")
    except Exception:
        return ""


def browser_ua(driver):
    try:
        return driver.execute_script("return navigator.userAgent;")
    except Exception:
        return ""

_PROXY = None
def _pick_proxy():
    global _PROXY
    if globals().get("_BROWSER_PX"):
        return globals()["_BROWSER_PX"]
    try:
        import proxy_pool
        px = proxy_pool.next_proxy()
        if px:
            _PROXY = px
            return px
    except Exception as e:
        log("  [proxy] pool no disponible: %s" % e)
    return _PROXY

def capsolver_create(website_url, website_key, enterprise, **kwargs):
    key = capsolver_key()
    if not key:
        log("  [captcha] sin CapSolver API key en settings")
        return None
    px = _pick_proxy()
    if px:
        try:
            import proxy_pool
            ttype = "ReCaptchaV2EnterpriseTask" if enterprise else "ReCaptchaV2Task"
            task = {"type": ttype, "websiteURL": website_url, "websiteKey": website_key}
            task.update(proxy_pool.capsolver_proxy_fields(px))
            log("  [proxy] resolviendo via %s (%s)" % (px[0], px[1]))
        except Exception:
            px = None
    if not px:
        ttype = "ReCaptchaV2EnterpriseTaskProxyLess" if enterprise else "ReCaptchaV2TaskProxyLess"
        task = {"type": ttype, "websiteURL": website_url, "websiteKey": website_key}
    if kwargs.get("invisible"):
        task["isInvisible"] = True
    if kwargs.get("userAgent"):
        task["userAgent"] = kwargs["userAgent"]
    payload = {"clientKey": key, "task": task}
    try:
        r = json.loads(U.urlopen(U.Request("https://api.capsolver.com/createTask",
            data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}),
            timeout=60).read().decode())
        return r.get("taskId")
    except Exception as e:
        log("  [captcha] createTask fallo: %s" % e)
        return None


def capsolver_poll(task_id, tries=24):
    key = capsolver_key()
    for i in range(tries):
        time.sleep(5)
        try:
            rr = json.loads(U.urlopen(U.Request("https://api.capsolver.com/getTaskResult",
                data=json.dumps({"clientKey": key, "taskId": task_id}).encode(),
                headers={"Content-Type": "application/json"}), timeout=60).read().decode())
        except Exception as e:
            log("  [captcha] poll error: %s" % e)
            continue
        if rr.get("status") == "ready":
            return rr.get("solution", {}).get("gRecaptchaResponse")
        if rr.get("status") == "failed":
            log("  [captcha] task failed: %s" % json.dumps(rr)[:200])
            return None
        log("  [captcha] esperando token... (%d)" % i)
    return None


def get_sitekey(driver):
    import re
    """Sitekey + si es enterprise, aunque el widget sea invisible."""
    try:
        src = driver.page_source
    except Exception:
        return None, False
    m = re.search(r'data-sitekey="([^"]+)"', src)
    if m:
        return m.group(1), ("enterprise" in src[:src.find(m.group(0))][-2000:] or "enterprise.js" in src)
    m = re.search(r"recaptcha/(?:enterprise\.js|api\.js)\?[^\s\"']*[?&]k=([^&\s\"']+)", src)
    if m:
        return m.group(1), ("enterprise" in m.group(0))
    for f in driver.find_elements("xpath", "//iframe[contains(@src,'recaptcha')]"):
        s = f.get_attribute("src") or ""
        mk = re.search(r"[?&]k=([^&]+)", s)
        if mk:
            return mk.group(1), ("enterprise" in s)
    m = re.search(r"render[\s:'\"]+([0-9A-Za-z_-]{30,})", src)
    if m:
        return m.group(1), ("enterprise" in src)
    return None, False

def presolve_captcha(driver):
    """Token invisible antes del envio. True si no hizo falta o se inyecto."""
    sk, ent = get_sitekey(driver)
    if not sk:
        log("  [captcha] sin sitekey en pagina")
        return True
    log("  [captcha] pre-solve sitekey %s... enterprise=%s" % (sk[:12], ent))
    tid = capsolver_create(driver.current_url, sk, ent, invisible=True, userAgent=browser_ua(driver))
    if not tid:
        return True
    token = capsolver_poll(tid)
    if not token:
        return True
    inject_token(driver, token)
    return True

def try_real_checkbox(driver, wait_s=20):
    """Clic REAL al checkbox (IP residencial propia). True si se marco."""
    import time as _t
    try:
        boxes = driver.find_elements("xpath", "//iframe[contains(@src,'recaptcha')]")
        if not boxes:
            return False
        anchor = None
        for f in boxes:
            s = f.get_attribute("src") or ""
            if "anchor" in s:
                anchor = f
                break
        if anchor is None:
            anchor = boxes[0]
        driver.switch_to.frame(anchor)
        try:
            cb = driver.find_element("xpath", "//*[@id='recaptcha-anchor' or @class='recaptcha-checkbox']")
            cb.click()
            log("  [captcha] clic real al checkbox")
        finally:
            driver.switch_to.default_content()
        _t.sleep(wait_s)
        tok = driver.execute_script(
            "var t=document.querySelector('#g-recaptcha-response');return t?t.value:'';");
        if tok and len(tok) > 20:
            log("  [captcha] checkbox marcado solo (%d chars)" % len(tok))
            return True
        # si salio reto de imagenes, no lo tocamos
        imgs = driver.find_elements("xpath", "//iframe[contains(@src,'recaptcha')]")
        if len(imgs) > 1:
            log("  [captcha] salio reto de imagenes: se deja pendiente")
        return False
    except Exception as e:
        try:
            driver.switch_to.default_content()
        except Exception:
            pass
        log("  [captcha] clic real fallo: %s" % str(e)[:100])
        return False

def solve_page_captcha(driver):
    """Si hay reCAPTCHA visible, lo resuelve e inyecta. True si no habia o se resolvio."""
    import re as _re
    iframes = driver.find_elements("xpath", "//iframe[contains(@src,'recaptcha')]")
    if not iframes:
        log("  [captcha] no hay widget visible, se continua")
        return True
    src = iframes[0].get_attribute("src") or ""
    mk = _re.search(r"[?&]k=([^&]+)", src)
    if not mk:
        log("  [captcha] sin sitekey")
        return False
    sitekey = mk.group(1)
    enterprise = "enterprise" in src
    log("  [captcha] sitekey %s... enterprise=%s" % (sitekey[:12], enterprise))
    tid = capsolver_create(driver.current_url, sitekey, enterprise, userAgent=browser_ua(driver))
    if not tid:
        return False
    token = capsolver_poll(tid)
    if not token:
        return False
    log("  [captcha] token %d chars, inyectando" % len(token))
    inject_token(driver, token)
    time.sleep(3)
    return True


def inject_token(driver, token):
    driver.execute_script("""
      const tk = arguments[0];
      document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response')
        .forEach(t => { t.value = tk; });
      if (typeof window.onChange === 'function') { try { window.onChange(tk); } catch(e){} }
      if (window.___grecaptcha_cfg) {
        for (const cid in window.___grecaptcha_cfg.clients) {
          try {
            const c = window.___grecaptcha_cfg.clients[cid];
            const g = c.g && c.g.g;
            if (g) { const cb = window[g.callback]; if (typeof cb === 'function') cb(tk); }
          } catch(e){}
        }
      }
      return true;
    """, token)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--dob", default="")
    ap.add_argument("--random-dob", action="store_true")
    ap.add_argument("--gender", default="random")
    ap.add_argument("--name", default="")
    ap.add_argument("--profile", default="auto")
    ap.add_argument("--headless", action="store_true")
    a = ap.parse_args()

    if len(a.password) < 10:
        print("ERROR: la contrasena necesita 10+ caracteres")
        return 1

    brave = brave_paths()
    udd = user_data_dir()
    if not brave or not udd:
        print("ERROR: no se encontro Brave en esta PC")
        return 1
    profiles = list_profiles(udd)
    if not profiles:
        print("ERROR: sin perfiles Brave en esta PC")
        return 1

    if a.profile == "auto":
        st = load_state()
        free = free_profiles(udd, st.get("used", []))
        if not free:
            free = [p for p in profiles if p not in st.get("used", [])]
            if not free:
                print("ERROR: los %d perfiles ya se usaron (borra brave_profiles.json para reutilizar)" % len(profiles))
                return 1
            log("aviso: todos los libres estan bloqueados, se intenta el primero usado-libre")
        profile = free[0]
    else:
        profile = a.profile
    log("perfil: %s (%d disponibles)" % (profile, len(profiles)))

    if a.random_dob or not a.dob:
        y = random.randint(1985, 2002)
        m = random.randint(1, 12)
        import calendar
        d = random.randint(1, calendar.monthrange(y, m)[1])
        dob = (y, m, d)
    else:
        y, m, d = [int(x) for x in a.dob.split("-")]
        dob = (y, m, d)
    log("fecha: %04d-%02d-%02d" % dob)
    gender = random.choice(["Man", "Woman"]) if a.gender == "random" else a.gender
    _FN = ["Sonia", "Luis", "Marta", "Diego", "Lucia", "Carlos", "Elena", "Pablo", "Sara", "Hugo",
           "Carmen", "Adrian", "Paula", "Mario", "Alba", "Ivan", "Nerea", "Oscar", "Julia", "Ruben",
           "Alex", "Dani", "Chris", "Sam", "Leo", "Maya", "Noa", "Eric", "Laia", "Joel"]
    _LN = ["Marez", "Ponce", "Vera", "Salas", "Ríos", "Cano", "Vega", "Prats", "Sol", "Luna",
           "Mar", "Roca", "Gil", "Sanz", "Blanco", "Pardo", "Serra", "Vidal", "Costa", "Marti"]
    name = a.name or (random.choice(_FN) + " " + random.choice(_LN))

    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait, Select
    from selenium.webdriver.support import expected_conditions as EC

    opts = Options()
    opts.binary_location = brave
    opts.add_argument("--user-data-dir=%s" % udd)
    opts.add_argument("--profile-directory=%s" % profile)
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    _rpx = _pick_proxy()
    if _rpx:
        try:
            import relay as _relay
            _rport = _relay.start_relay(_rpx[0], int(_rpx[1]), _rpx[2], _rpx[3])
            opts.add_argument("--proxy-server=http://127.0.0.1:%d" % _rport)
            opts.add_argument("--proxy-bypass-list=localhost,127.0.0.1")
            globals()["_BROWSER_PX"] = _rpx
            log("  [proxy] navegador via %s" % _rpx[0])
        except Exception as _e:
            log("  [proxy] relay fallo: %s" % _e)
    if a.headless:
        opts.add_argument("--headless=new")
    try:
        driver = webdriver.Chrome(options=opts)
    except Exception as e:
        log("reintentando arranque (limpiando procesos sueltos)...")
        try:
            import subprocess as _sp
            _sp.run(["taskkill", "/F", "/IM", "chromedriver.exe"],
                    capture_output=True, timeout=20)
        except Exception:
            pass
        time.sleep(3)
        driver = webdriver.Chrome(options=opts)
    wait = WebDriverWait(driver, 30)
    try:
        log("== 1. Correo ==")
        driver.get("https://www.spotify.com/signup/")
        wait.until(EC.presence_of_element_located((By.XPATH, "//input[@type='email']"))).send_keys(a.email)
        time.sleep(1)
        driver.find_element(By.XPATH, "//button[contains(., 'Next') or contains(., 'Siguiente')]").click()

        log("== 2. Contrasena ==")
        wait.until(EC.presence_of_element_located((By.XPATH, "//input[@type='password']"))).send_keys(a.password)
        time.sleep(1)
        driver.find_element(By.XPATH, "//button[contains(., 'Next') or contains(., 'Siguiente')]").click()

        log("== 3. Datos ==")
        wait.until(EC.presence_of_element_located((By.XPATH, "//input[@type='text' and @name='displayName'] | //input[contains(@name,'isplayName')]"))).send_keys(name)
        radios = driver.find_elements(By.XPATH, "//input[@type='radio']")
        def click_radio(r):
            try:
                r.find_element(By.XPATH, "./..").click()
            except Exception:
                driver.execute_script("arguments[0].click();",
                    driver.find_element(By.XPATH, "//label[@for='%s']" % r.get_attribute("id")))
        picked = False
        for r in radios:
            try:
                lbl = (r.get_attribute("value") or "") + " " + (r.find_element(By.XPATH, "./..").text or "")
            except Exception:
                lbl = r.get_attribute("value") or ""
            if gender.lower() in lbl.lower():
                click_radio(r)
                picked = True
                break
        if not picked and radios:
            click_radio(random.choice(radios))
        driver.find_element(By.XPATH, "//input[@placeholder='dd' or @name='day']").send_keys(str(dob[2]))
        months = ["January", "February", "March", "April", "May", "June", "July",
                  "August", "September", "October", "November", "December"]
        Select(driver.find_element(By.XPATH, "//select")).select_by_visible_text(months[dob[1] - 1])
        driver.find_element(By.XPATH, "//input[@placeholder='yyyy' or @name='year']").send_keys(str(dob[0]))
        time.sleep(1)
        driver.find_element(By.XPATH, "//button[contains(., 'Next') or contains(., 'Siguiente')]").click()

        log("== 4. Terminos y envio ==")
        time.sleep(6)
        for cb in driver.find_elements(By.XPATH, "//input[@type='checkbox']"):
            try:
                if not cb.is_selected():
                    cb.click()
            except Exception:
                pass
        time.sleep(1)
        presolve_captcha(driver)
        ok_markers = ["open.spotify.com", "account/overview", "download", "signup/login"]
        for intento in range(1, 3):
            btns = driver.find_elements(By.XPATH, "//button[contains(., 'Sign up') or contains(., 'Crear') or contains(., 'Regist') or contains(., 'Continuar') or contains(., 'Continue') or contains(., 'Verificar') or contains(., 'Verify')]")
            if btns:
                try:
                    btns[0].click()
                except Exception:
                    pass
            time.sleep(10)
            url = driver.current_url
            log("  intento %d url: %s" % (intento, url))
            if any(k in url for k in ok_markers) or ("challenge" not in url and "signup" not in url):
                break
            try:
                body = driver.find_element(By.TAG_NAME, "body").text.lower()
            except Exception:
                body = ""
            if ("captcha" in body or "robot" in body or "verifica" in body
                    or "challenge" in url
                    or driver.find_elements(By.XPATH, "//iframe[contains(@src,'recaptcha')]")):
                log("  [captcha] reto detectado, clic real primero (intento %d)" % intento)
                if "challenge.spotify.com" not in url and try_real_checkbox(driver):
                    continue
                log("  [captcha] token CapSolver (intento %d)" % intento)
                if not solve_page_captcha(driver):
                    print("CAPTCHA_NO_RESUELTO")
                    return 2
                continue
            break

        url = driver.current_url
        log("url final: %s" % url)
        if "challenge.spotify.com" in url:
            log("PENDIENTE: reto no superado, se deja para resolver a mano")
            print("PENDIENTE %s" % a.email)
            return 0
        if "open.spotify.com" in url or "account/overview" in url or "signup#step=3" not in url and "challenge" not in url:
            pass
        ok_markers = ["open.spotify.com", "account/overview", "download", "signup/login"]
        if any(k in url for k in ok_markers) or "challenge" not in url and "signup" not in url:
            log("CUENTA CREADA: %s (perfil %s)" % (a.email, profile))
            st = load_state()
            if profile not in st.get("used", []):
                st.setdefault("used", []).append(profile)
                save_state(st)
            print("OK %s" % a.email)
            return 0
        driver.save_screenshot(os.path.join(os.environ.get("TEMP", "."), "_brave_fin.png"))
        print("REVISAR: quedó en %s" % url)
        return 3
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
