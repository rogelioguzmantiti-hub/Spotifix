const { app, BrowserWindow, Menu, Tray, ipcMain, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const treeKill = require('tree-kill');

const iconPath = path.join(__dirname, 'assets/icon.ico');
const isPackaged = app.isPackaged;
const appPath = isPackaged ? path.join(process.resourcesPath, 'app') : __dirname;

let mainWindow;
let splashScreen;
let loginWindow;
let backendProcess;
let tray = null;
let consoleShown = false;
let consoleWindow = null;

let aiServerProcess = null;
let aiServerPort = 47254;
let aiServerPass = '';
let aiSessionId = null;
const AI_MODEL = 'big-pickle';

const LOGIN_USER = 'SpotifixAPP';
const LOGIN_PASS = 'Melona2019.';

function authStateFile() {
    return path.join(app.getPath('userData'), 'authed.json');
}

function isAuthenticated() {
    try {
        return fs.existsSync(authStateFile());
    } catch (e) {
        return false;
    }
}

function markAuthenticated() {
    try {
        fs.writeFileSync(authStateFile(), JSON.stringify({ authed: true }));
    } catch (e) {
        console.error('Failed to save auth state:', e);
    }
}


app.disableHardwareAcceleration();
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });


    function killProcessOnPort(port) {
        // Find the PID of the process using the specified port
        exec(`netstat -ano | findstr :${port}`, (err, stdout, stderr) => {
          if (err) {
            console.error(`Error finding process on port ${port}:`, stderr);
            return;
          }
      
          // Extract the PID from the command output
          const lines = stdout.trim().split('\n');
          if (lines.length > 0) {
            const parts = lines[0].trim().split(/\s+/);
            const pid = parts[parts.length - 1];
      
            // Kill the process with the found PID
            exec(`taskkill /PID ${pid} /F`, { windowsHide: true }, (err, stdout, stderr) => {
              if (err) {
                console.error(`Error killing process with PID ${pid}:`, stderr);
              } else {
                console.log(`Process with PID ${pid} on port ${port} was killed.`);
              }
            });
          } else {
            console.log(`No process found on port ${port}`);
          }
        });
      }




    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            cleanUpAndQuit();
        }
    });

    

    function createSplashScreen() {
        splashScreen = new BrowserWindow({
            width: 300,
            height: 180,
            transparent: true,
            frame: false,
            alwaysOnTop: false,
            resizable: false,
            fullscreenable: false,
            icon: iconPath,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                enableRemoteModule: false,
                sandbox: true, // Enable sandboxing
            },
        });

        splashScreen.loadFile('splash.html');
        splashScreen.show();
        splashScreen.on('closed', () => {
            splashScreen = null;
        });
    }

    function createMainWindow(token) {
        if (splashScreen) {
            splashScreen.close(); // Close splash screen if main window is to be shown
        }

        Menu.setApplicationMenu(Menu.buildFromTemplate([
            { label: 'Edit', submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]}
        ]));
        mainWindow = new BrowserWindow({
            minWidth: 1380,
            minHeight: 770,
            width: 1380,
            height: 770,
            resizable: true,
            frame: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                nodeIntegration: false, // Disable Node.js integration
                contextIsolation: true, // Enforce context isolation
                enableRemoteModule: false, // Disable remote module for security
                sandbox: true, // Enable sandboxing for additional security
            },
        });

        mainWindow.loadFile('index.html').catch(err => {
            console.error('Failed to load index.html:', err);
        });

        mainWindow.webContents.on('context-menu', (event, params) => {
            const menu = Menu.buildFromTemplate([
                { label: 'Cortar', role: 'cut', enabled: params.selectionText.length > 0 },
                { label: 'Copiar', role: 'copy', enabled: params.selectionText.length > 0 },
                { label: 'Pegar', role: 'paste', enabled: params.isEditable },
                { type: 'separator' },
                { label: 'Seleccionar todo', role: 'selectAll', enabled: params.isEditable }
            ]);
            menu.popup();
        });
        mainWindow.webContents.on('did-finish-load', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('token-received', token);
            }
        });

        // Safety: re-send token until renderer confirms (avoids race where DOMContentLoaded
        // registers the token listener after did-finish-load already fired).
        let tokenRetries = 0;
        const tokenRetryInterval = setInterval(() => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                clearInterval(tokenRetryInterval);
                return;
            }
            if (tokenRetries >= 10) {
                clearInterval(tokenRetryInterval);
                return;
            }
            tokenRetries += 1;
            mainWindow.webContents.send('token-received', token);
        }, 500);

        mainWindow.on('closed', () => {
            mainWindow = null;
            cleanUpAndQuit();
        });

        //if (process.env.NODE_ENV !== 'development') {
        //    mainWindow.webContents.on('devtools-opened', () => {
        //        mainWindow.webContents.closeDevTools();
        //    });
        //}
        //mainWindow.webContents.openDevTools();
    }

    async function autoLogin() {
        try {
            const response = await axios.post('http://127.0.0.1:8999/register', { username: 'local' });
            if (response.data.success) {
                return response.data.token;
            }
        } catch (error) {
            console.error('Auto-login failed:', error);
        }
        return '';
    }

    function createLoginWindow() {
        loginWindow = new BrowserWindow({
            width: 350,
            height: 522,
            resizable: false,
            frame: false,
            transparent: true,
            icon: iconPath,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                enableRemoteModule: false,
            },
        });

        loginWindow.loadFile('login.html');
        loginWindow.show();

        loginWindow.on('closed', () => {
            loginWindow = null;
        });
    }

    ipcMain.on('login-attempt', (event, data) => {
        const { payload } = data;
        const username = payload.username;
        const password = payload.password;

        if (username === LOGIN_USER && password === LOGIN_PASS) {
            markAuthenticated();
            event.reply('login-response', {
                success: true,
                message: 'Login successful!'
            });
        } else {
            event.reply('login-response', {
                success: false,
                message: 'Invalid credentials'
            });
        }
    });

    function createConsoleWindow() {
        consoleWindow = new BrowserWindow({
            width: 750,
            height: 470,
            minWidth: 750,
            minHeight: 470,
            frame: false,
            show: false, // Fenster zunächst versteckt
            icon: iconPath,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                enableRemoteModule: false,  // empfohlen, um Sicherheitsprobleme zu vermeiden
                preload: path.join(__dirname, 'preload.js'),
                scrollable: false,
            },
        });

        consoleWindow.loadFile('console.html');
        consoleWindow.setMenu(null);

        consoleWindow.on('close', (event) => {
            if (!app.isQuitting) {
                event.preventDefault();
                consoleWindow.hide();
                consoleShown = false;
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('console-toggled', 'Show Console');
                }
            } else {
                consoleWindow = null; // If app is quitting, allow window to close properly
            }
        });

        consoleWindow.on('closed', () => {
            consoleWindow = null;
        });

        consoleWindow.on('show', () => {
            consoleShown = true;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('console-toggled', 'Hide Console');
            }
        });

        consoleWindow.on('hide', () => {
            consoleShown = false;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('console-toggled', 'Show Console');
            }
        });
    }


    async function waitForBackendReady() {
        while (true) {
            try {
                console.log('Attempting to check backend readiness...');
                const response = await axios.post('http://127.0.0.1:8999/backend');
                if (response.data.ready) {
                    console.log('Backend is ready');
                    break;
                } else {
                    console.log(`Backend not ready yet, reason: ${response.data.message}. Retrying in 1 second...`);
                }
            } catch (error) {
                console.log(`Error checking backend readiness: ${error.message}. Retrying in 1 second...`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    ipcMain.on('toggle-console', (event) => {
        if (consoleWindow === null) {
            createConsoleWindow();
        }

        if (consoleWindow.isVisible()) {
            consoleWindow.hide();
        } else {
            consoleWindow.show();
        }
    });

    ipcMain.on('close-app', () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
            focusedWindow.close();
        }
    });

    ipcMain.on('restart-app', () => {
        console.log('Restart requested via IPC. Relaunching...');
        if (backendProcess && !backendProcess.killed) {
            treeKill(backendProcess.pid, 'SIGTERM', () => {});
        }
        setTimeout(() => {
            app.relaunch({ args: process.argv.slice(1) });
            app.exit(0);
        }, 1000);
    });

    ipcMain.handle('batch-export', async () => {
        const items = batch ? batch.items : [];
        if (!items.length) return { ok: false, error: 'No hay resultados todavia.' };
        return { ok: true, path: exportBatchResults(items, 'Exportacion manual del lote') };
    });

    ipcMain.handle('batch-resume-info', async () => {
        const r = readBatchResume();
        if (!r || !r.queue || !r.queue.length) return { ok: true, pending: 0 };
        return { ok: true, pending: r.queue.length, total: r.total, done: r.done };
    });

    ipcMain.handle('batch-resume', async () => {
        if (batch) return { ok: false, error: 'Ya hay un lote en marcha.' };
        const r = readBatchResume();
        if (!r || !r.queue || !r.queue.length) return { ok: false, error: 'No hay lote pendiente.' };
        const adb = findAdb();
        if (!adb) return { ok: false, error: "No se encontro 'adb.exe'." };
        const devs = await new Promise((resolve) => {
            exec('"' + adb + '" devices', { windowsHide: true, timeout: 20000 }, (err, stdout) => {
                const list = [];
                String(stdout || '').split(/\r?\n/).forEach((raw) => {
                    const line = raw.trim();
                    if (!line || line.startsWith('List of devices') || line.startsWith('*')) return;
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2 && parts[1] === 'device') list.push(parts[0]);
                });
                resolve(list);
            });
        });
        if (devs.length === 0) return { ok: false, error: 'adb no ve ningun telefono listo.' };
        const sender = batchSender();
        batch = {
            queue: r.queue, index: 0, devices: devs, deviceIdx: 0,
            adb: findAdb(), password: r.password, opts: r.opts || {},
            paused: false, stopped: false, proc: null, sawCaptcha: false,
            ok: r.ok || 0, captcha: r.captcha || 0, fail: r.fail || 0,
            proxies: [], items: r.items || [], failStreak: 0, rateHits: 0, rateTimer: null
        };
        batchNotify(sender, 'phase', 'Lote reanudado: ' + r.queue.length + ' cuenta(s) pendientes.');
        discordNotify('Spotifix lote reanudado: ' + r.queue.length + ' pendientes.');
        batchRunNext();
        return { ok: true, total: r.queue.length, devices: devs };
    });

    ipcMain.handle('vpn-usa-all', async () => {
        const adb = findAdb();
        if (!adb) return { ok: false, error: "No se encontro 'adb.exe'." };
        const devs = await new Promise((resolve) => {
            exec('"' + adb + '" devices', { windowsHide: true, timeout: 20000 }, (err, stdout) => {
                const list = [];
                String(stdout || '').split(/\r?\n/).forEach((raw) => {
                    const line = raw.trim();
                    if (!line || line.startsWith('List of devices') || line.startsWith('*')) return;
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2 && parts[1] === 'device') list.push(parts[0]);
                });
                resolve(list);
            });
        });
        if (!devs.length) return { ok: false, error: 'adb no ve ningun telefono listo.' };
        const sender = batchSender();
        const emit = (texto) => batchNotify(sender, 'vpn-event', { texto: texto });
        emit('VPN USA: iniciando en ' + devs.length + ' dispositivo(s)...');
        discordNotify('Spotifix VPN USA: iniciando en ' + devs.length + ' dispositivo(s).');
        const script = path.join(appPath, 'Tools', 'surf_rotate.py');
        const results = await Promise.all(devs.map((dev) => new Promise((resolve) => {
            emit('[' + dev + '] conectando USA...');
            exec('python "' + script + '" "' + dev + '"', { windowsHide: true, timeout: 720000 }, async (err, stdout) => {
                const out = String(stdout || '');
                const okm = out.match(/SURF-OK\s+(\S+)\s+(\S+)\s+(\S+)/);
                if (okm) {
                    try {
                        const reg = await axios.post('http://127.0.0.1:8999/register', { username: 'local' }, { timeout: 15000 });
                        if (reg.data && reg.data.token) {
                            await axios.post('http://127.0.0.1:8999/device_vpn_set', { udid: dev, location: okm[1] + ', USA', ip: okm[2], on: true }, { headers: { Authorization: 'Bearer ' + reg.data.token }, timeout: 15000 });
                        }
                    } catch (e) {}
                    emit('[' + dev + '] OK: ' + okm[1] + ' ' + okm[2]);
                    resolve({ dev: dev, ok: true, detail: okm[1] + ' ' + okm[2] });
                } else {
                    const fm = out.match(/SURF-FAIL\s+(.*)/);
                    emit('[' + dev + '] FALLO: ' + ((fm && fm[1]) || 'ver log').trim());
                    resolve({ dev: dev, ok: false, detail: ((fm && fm[1]) || 'error').trim() });
                }
            });
        })));
        const okN = results.filter((r) => r.ok).length;
        emit('VPN USA terminado: ' + okN + '/' + results.length + ' en USA.');
        discordNotify('Spotifix VPN USA terminado: ' + okN + '/' + results.length + ' en USA.\n' + results.map((r) => (r.ok ? 'OK ' : 'FAIL ') + r.dev + ' ' + r.detail).join('\n'));
        return { ok: true, results: results };
    });

    let brave = null;
    function braveNotify(sender, type, data) {
        if (sender && !sender.isDestroyed()) sender.send('brave-event', { type: type, data: data });
    }
    async function braveRunNext() {
        if (!brave || brave.stopped) return;
        if (brave.proc) return;
        if (brave.index >= brave.queue.length) {
            const b = brave;
            const resumen = 'Brave terminado: ' + b.ok + ' correcta(s), ' + b.fail + ' con error.';
            const exp = exportBatchResults(b.items, resumen);
            braveNotify(batchSender(), 'log', { texto: '  [export] ' + exp });
            braveNotify(batchSender(), 'finished', { resumen: resumen + ' ' + exp });
            discordNotify('Spotifix Brave terminado: ' + resumen + '\n' + exp);
            brave = null;
            return;
        }
        const email = brave.queue[brave.index];
        const sender = batchSender();
        braveNotify(sender, 'item-start', { email: email, indice: brave.index + 1, total: brave.queue.length });
        const args = ['Tools/spotify-brave.py', '--email', email, '--password', brave.password, '--random-dob', '--gender', 'random', '--profile', 'auto'];
        const p2 = spawn('python', args, { cwd: appPath, windowsHide: true });
        brave.proc = p2;
        let out = '';
        const onData = (buf) => {
            const s = String(buf);
            out += s;
            braveNotify(sender, 'log', s);
        };
        p2.stdout.setEncoding('utf8');
        p2.stderr.setEncoding('utf8');
        p2.stdout.on('data', onData);
        p2.stderr.on('data', onData);
        p2.on('error', (err) => {
            braveNotify(sender, 'log', '\nError al arrancar Python: ' + err.message + '\n');
            if (brave) brave.proc = null;
        });
        p2.on('close', (code) => {
            if (!brave) return;
            brave.proc = null;
            const rotar = brave.rotateVpn && /CAPTCHA_NO_RESUELTO|\[captcha\] reto detectado/i.test(out);
            let resultado = 'error', detalle = 'codigo ' + code;
            if (/^OK\s+/m.test(out)) { resultado = 'ok'; detalle = ''; brave.ok++; }
            else if (/CAPTCHA_NO_RESUELTO/.test(out)) { resultado = 'captcha'; detalle = 'captcha sin resolver'; brave.fail++; }
            else { brave.fail++; }
            const seguir = () => {
                brave.items.push({ email: email, resultado: resultado, detalle: detalle, proxy: 'brave-local', hora: new Date().toISOString() });
                appendBatchResult(email, brave.password, resultado === 'ok' ? 'ok' : 'captcha');
                braveNotify(sender, 'item', { email: email, resultado: resultado, detalle: detalle });
                brave.index++;
                setTimeout(() => { braveRunNext(); }, 500);
            };
            if (rotar) {
                braveNotify(sender, 'log', { texto: '  [vpn] captcha detectado: rotando IP USA...' });
                exec('python "' + path.join(appPath, 'Tools', 'vpn_rotate.py') + '" --rotate', { windowsHide: true, timeout: 300000 }, (err, stdout) => {
                    braveNotify(sender, 'log', { texto: '  [vpn] ' + String(stdout || '').trim().split('\n').slice(-3).join(' | ') });
                    seguir();
                });
                return;
            }
            seguir();
        });
    }
    ipcMain.handle('brave-start', async (event, payload) => {
        if (brave) return { ok: false, error: 'Ya hay un lote Brave en marcha.' };
        const p = payload || {};
        const cantidad = parseInt(p.cantidad, 10);
        if (isNaN(cantidad) || cantidad < 1) return { ok: false, error: 'Cantidad no valida.' };
        if (cantidad > 60) return { ok: false, error: 'Maximo 60 (perfiles Brave).' };
        if (!p.password || p.password.length < 10) return { ok: false, error: 'Contrasena de 10+ caracteres.' };
        const sender = batchSender();
        braveNotify(sender, 'phase', 'Generando ' + cantidad + ' correo(s)...');
        const gen = await runPythonEmails(cantidad);
        if (!gen.ok) return { ok: false, error: gen.error };
        if (!gen.emails.length) return { ok: false, error: 'No se genero ningun correo.' };
        brave = { queue: gen.emails, index: 0, password: p.password, proc: null, stopped: false, items: [], ok: 0, fail: 0, rotateVpn: p.rotateVpn !== false };
        braveNotify(sender, 'phase', 'Brave iniciado: ' + gen.emails.length + ' cuenta(s).');
        discordNotify('Spotifix Brave iniciado: ' + gen.emails.length + ' cuenta(s).');
        braveRunNext();
        return { ok: true, total: gen.emails.length };
    });
    ipcMain.handle('brave-stop', async () => {
        if (!brave) return { ok: true };
        brave.stopped = true;
        if (brave.proc && !brave.proc.killed) { try { treeKill(brave.proc.pid, 'SIGTERM', () => {}); } catch (e) {} }
        const b = brave;
        const resumen = 'Brave detenido: ' + b.ok + ' correcta(s), ' + b.fail + ' con error.';
        const exp = exportBatchResults(b.items, resumen);
        brave = null;
        braveNotify(batchSender(), 'finished', { resumen: resumen + ' ' + exp, parcial: true });
        return { ok: true };
    });

    app.on('before-quit', () => {
        console.log('Application is quitting. Terminating backend process...');
        app.isQuitting = true;  // Set a flag indicating app is quitting
        cleanUpAndQuit();
    });

    ipcMain.on('minimize-app', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    });

    ipcMain.on('close-window', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    function createTray() {
        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Show',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                    }
                }
            },
            {
                label: 'Exit',
                click: () => {
                    cleanUpAndQuit();
                }
            }
        ]);

        tray.setToolTip(`Spotifix`);
        tray.setContextMenu(contextMenu);
    }

    function spawnBackend() {
        const apiExePath = path.join(appPath, 'api.exe');
        const apiExePathAlt = path.join(appPath, 'api', 'api.exe');
        const apiPyPath = path.join(appPath, 'api.py');
        let proc;
        // IMPORTANT: prefer python api.py so the in-app updater (which replaces
        // api.py/main.js/etc. but NEVER api/api.exe) actually takes effect.
        if (fs.existsSync(apiPyPath)) {
            proc = spawn('python', [apiPyPath], { cwd: appPath });
        } else if (fs.existsSync(apiExePath)) {
            proc = spawn(apiExePath, [], { cwd: appPath });
        } else if (fs.existsSync(apiExePathAlt)) {
            proc = spawn(apiExePathAlt, [], { cwd: path.join(appPath, 'api') });
        } else {
            proc = spawn('python', ['api.py']); // fallback
        }

        proc.stdout.on('data', (data) => {
            console.log(`[Backend] ${data}`);
        });

        proc.stderr.on('data', (data) => {
            console.error(`[Backend] ${data}`);
        });

        proc.on('error', (err) => {
            console.error('Backend process error:', err);
        });

        proc.on('exit', (code, signal) => {
            console.log(`Backend process exited with code ${code} signal ${signal}`);
            backendProcess = null;
            const restartFlag = path.join(appPath, '_update_restart');
            let isUpdateRestart = false;
            try {
                if (fs.existsSync(restartFlag)) {
                    isUpdateRestart = true;
                    fs.unlinkSync(restartFlag);
                }
            } catch (e) {}
            if (isUpdateRestart) {
                console.log('Update restart detected. Relaunching app...');
                setTimeout(() => {
                    app.relaunch({ args: process.argv.slice(1) });
                    app.exit(0);
                }, 500);
                return;
            }
            if (!app.isQuitting) {
                console.log('Restarting backend in 3 seconds...');
                setTimeout(() => {
                    if (!app.isQuitting) {
                        backendProcess = spawnBackend();
                    }
                }, 3000);
            }
        });

        return proc;
    }

    let backendHealthInterval = null;

    function startBackendHealthCheck() {
        // Check backend health every 30 seconds
        backendHealthInterval = setInterval(async () => {
            try {
                const response = await axios.post('http://127.0.0.1:8999/backend');
                if (!response.data.ready) {
                    console.log('Backend health check: not ready yet');
                }
            } catch (error) {
                console.error('Backend health check failed:', error.message);
                // Backend is down; if process is null, restart will happen via exit handler
                if (!backendProcess || backendProcess.killed) {
                    console.log('Backend process is dead, health check will rely on exit handler');
                }
            }
        }, 30000);
    }

    // ---------------- IA (openCode) ----------------

    function aiAuthHeader() {
        return 'Basic ' + Buffer.from('opencode:' + aiServerPass).toString('base64');
    }

    function resolveOpenCodeBin() {
        const candidates = [];
        if (process.env.OPENCODE_BIN) candidates.push(process.env.OPENCODE_BIN);
        candidates.push(path.join(appPath, 'opencode.exe'));
        candidates.push(path.join(appPath, 'resources', 'opencode.exe'));
        if (process.env.APPDATA) {
            candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
        }
        for (const c of candidates) {
            try {
                if (fs.existsSync(c)) return c;
            } catch (e) {}
        }
        return 'opencode';
    }

    function aiDataDir() {
        return path.join(app.getPath('userData'), 'opencode-data');
    }

    function spawnAIServer() {
        if (aiServerProcess && !aiServerProcess.killed) return aiServerProcess;
        aiServerPass = crypto.randomUUID();
        const bin = resolveOpenCodeBin();
        const args = ['serve', '--port', String(aiServerPort), '--hostname', '127.0.0.1'];
        console.log(`[AI] spawning ${bin} on port ${aiServerPort}`);
        try { require('fs').writeFileSync(process.env.TEMP + '\\opencode\\ai_pass.txt', aiServerPass); } catch (e) {}
        aiServerProcess = spawn(bin, args, {
            cwd: appPath,
            windowsHide: true,
            env: Object.assign({}, process.env, {
                OPENCODE_SERVER_USERNAME: 'opencode',
                OPENCODE_SERVER_PASSWORD: aiServerPass,
                XDG_DATA_HOME: aiDataDir(),
            }),
        });
        aiServerProcess.stdout.on('data', (d) => { console.log(`[AI] ${d}`); });
        aiServerProcess.stderr.on('data', (d) => { console.error(`[AI] ${d}`); });
        aiServerProcess.on('error', (err) => { console.error('[AI] spawn error:', err); });
        aiServerProcess.on('exit', (code, signal) => {
            console.log(`[AI] server exited code ${code} signal ${signal}`);
            aiServerProcess = null;
            aiSessionId = null;
        });
        return aiServerProcess;
    }

    async function waitForAIServer(timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 30000);
        while (Date.now() < deadline) {
            try {
                const res = await axios.get(`http://127.0.0.1:${aiServerPort}/global/health`, {
                    headers: { Authorization: aiAuthHeader() },
                    timeout: 3000,
                });
                if (res.data && res.data.healthy) return true;
            } catch (e) {}
            await new Promise((r) => setTimeout(r, 500));
        }
        return false;
    }

    async function aiPost(url, data, timeoutMs) {
        const res = await axios.post(`http://127.0.0.1:${aiServerPort}${url}`, data, {
            headers: { 'Content-Type': 'application/json', Authorization: aiAuthHeader() },
            timeout: timeoutMs || 30000,
        });
        return res.data;
    }

    async function aiGet(url, timeoutMs) {
        const res = await axios.get(`http://127.0.0.1:${aiServerPort}${url}`, {
            headers: { Authorization: aiAuthHeader() },
            timeout: timeoutMs || 15000,
        });
        return res.data;
    }

    function aiSleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    function aiPermissionRules() {
        return {
            permission: [
                { permission: 'bash', pattern: '*', action: 'allow' },
                { permission: 'read', pattern: '*', action: 'allow' },
                { permission: 'edit', pattern: '*', action: 'allow' },
                { permission: 'write', pattern: '*', action: 'allow' },
                { permission: 'glob', pattern: '*', action: 'allow' },
                { permission: 'grep', pattern: '*', action: 'allow' },
                { permission: 'webfetch', pattern: '*', action: 'allow' },
                { permission: 'websearch', pattern: '*', action: 'allow' },
                { permission: 'task', pattern: '*', action: 'allow' },
                { permission: 'skill', pattern: '*', action: 'allow' },
                { permission: 'external_directory', pattern: '*', action: 'allow' },
                { permission: 'doom_loop', pattern: '*', action: 'allow' },
                { permission: 'question', pattern: '*', action: 'deny' },
            ],
        };
    }

    async function aiEnsureSession() {
        if (aiSessionId) return aiSessionId;
        const res = await aiPost('/session', Object.assign({ title: 'Spotifix IA' }, aiPermissionRules()), 60000);
        aiSessionId = res.id;
        return aiSessionId;
    }

    async function aiChatText(text, onProgress) {
        let sid = await aiEnsureSession();
        try {
            await aiPost(`/session/${sid}/prompt_async`, {
                parts: [{ type: 'text', text }],
                model: { providerID: 'opencode', modelID: AI_MODEL },
            }, 120000);
        } catch (err) {
            if (err.response && err.response.status === 404) {
                aiSessionId = null;
                sid = await aiEnsureSession();
                await aiPost(`/session/${sid}/prompt_async`, {
                    parts: [{ type: 'text', text }],
                    model: { providerID: 'opencode', modelID: AI_MODEL },
                }, 120000);
            } else {
                throw err;
            }
        }

        const deadline = Date.now() + (6 * 60 * 60 * 1000);
        let lastText = '';
        while (Date.now() < deadline) {
            if (!aiServerProcess || aiServerProcess.killed) {
                throw new Error('El servidor de IA se detuvo durante la tarea');
            }
            await aiSleep(1500);
            let data;
            try {
                data = await aiGet(`/session/${sid}/message?limit=2`, 30000);
            } catch (e) { continue; }
            if (!Array.isArray(data) || !data.length) continue;
            const last = data[data.length - 1];
            const parts = (last && last.parts) || [];
            const textParts = parts
                .filter((p) => p.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text);
            const full = textParts.join('\n').trim();
            if (full && full !== lastText) {
                lastText = full;
                if (onProgress) onProgress(full);
            }
            const info = (last && last.info) || {};
            const done = info.done === true || (info.time && info.time.completed);
            if (done) {
                return { text: full || lastText, parts: parts };
            }
        }
        throw new Error('La tarea superó el tiempo máximo de espera (6 horas)');
    }

    ipcMain.handle('ai-status', async () => {
        if (!aiServerProcess || aiServerProcess.killed) {
            spawnAIServer();
        }
        const ready = await waitForAIServer(15000);
        return { ready, session: !!aiSessionId, port: aiServerPort, model: AI_MODEL };
    });

    ipcMain.handle('ai-chat', async (event, payload) => {
        const text = (payload && payload.text) || '';
        if (!text.trim()) return { ok: false, error: 'Mensaje vacío' };
        try {
            if (!aiServerProcess || aiServerProcess.killed) spawnAIServer();
            const ready = await waitForAIServer(60000);
            if (!ready) return { ok: false, error: 'El servidor de IA no pudo iniciarse' };
            const result = await aiChatText(text, (progress) => {
                if (event && event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('ai-progress', progress);
                }
            });
            return { ok: true, text: result.text };
        } catch (err) {
            console.error('[AI] chat error:', err);
            let detail = err.message;
            if (err.response && err.response.data) {
                const d = err.response.data;
                detail = (d.data && d.data.message) || (typeof d === 'string' ? d : JSON.stringify(d));
            }
            return { ok: false, error: detail };
        }
    });

    ipcMain.handle('ai-reset', async () => {
        aiSessionId = null;
        return { ok: true };
    });

    // ---- Automat: registro de Spotify por ADB ----

    let automatProc = null;

    // El script de PowerShell llama a 'adb' por su nombre, asi que hay que
    // anteponer la carpeta donde esta: si no, no lo encuentra aunque nosotros si.
    //
// En Windows la variable se llama 'Path', no 'PATH'. Leer 'PATH' a mano devuelve
// undefined y hace que el escaneo del PATH no encuentre nada.
function getPathEnv() {
    const clave = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
    return (clave && process.env[clave]) || '';
}

function pathWithAdb() {
    const actual = getPathEnv();
    const adbDir = findAdbDir();
    return adbDir ? adbDir + path.delimiter + actual : actual;
}

function findAdb() {
        const candidates = [
            path.join(process.env.APPDATA || '', 'Spotifix', 'Spotify Mobile', 'Files', 'Adb', 'adb.exe'),
            'C:\\Program Files (x86)\\panda_android\\tools\\adb.exe'
        ];
        for (const c of candidates) {
            try { if (c && fs.existsSync(c)) return c; } catch (e) { }
        }
        const dirs = getPathEnv().split(path.delimiter);
        for (const d of dirs) {
            try {
                const full = path.join(d.trim(), 'adb.exe');
                if (full && fs.existsSync(full)) return full;
            } catch (e) { }
        }
        return null;
    }

    // El script llama a 'adb' por su nombre, asi que al lanzar PowerShell hay que
    // anteponer la carpeta donde esta: si no, no lo encuentra aunque nosotros si.
    function findAdbDir() {
        const adb = findAdb();
        return adb ? path.dirname(adb) : '';
    }

    ipcMain.handle('automat-adb-devices', async () => {
        const adb = findAdb();
        if (!adb) return { ok: false, error: "No se encontro 'adb.exe'." };
        return new Promise((resolve) => {
            exec(`"${adb}" devices`, { windowsHide: true, timeout: 20000 }, (err, stdout) => {
                const devices = [];
                String(stdout || '').split(/\r?\n/).forEach((raw) => {
                    const line = raw.trim();
                    if (!line || line.startsWith('List of devices') || line.startsWith('*')) return;
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2 && parts[1] === 'device') devices.push(parts[0]);
                });
                if (err && devices.length === 0) {
                    resolve({ ok: false, error: 'No se pudo listar dispositivos: ' + err.message });
                    return;
                }
                resolve({ ok: true, devices });
            });
        });
    });

    ipcMain.handle('automat-signup-start', async (event, payload) => {
        if (automatProc && !automatProc.killed) {
            return { ok: false, error: 'Ya hay un registro en marcha.' };
        }
        const adb = findAdb();
        if (!adb) return { ok: false, error: "No se encontro 'adb.exe'." };

        const script = path.join(appPath, 'Tools', 'spotify-signup.ps1');
        if (!fs.existsSync(script)) {
            return { ok: false, error: 'No se encontro spotify-signup.ps1 en Tools\\.' };
        }

        const p = payload || {};
        const args = [];
        const cuentaProxy = batch.proxies.length > 0 ? batch.proxies[batch.index % batch.proxies.length] : null;
        batchNotify(sender, 'log', { texto: cuentaProxy ? ('  [proxy] ' + device + ': usa ' + cuentaProxy.label) : ('  [proxy] ' + device + ': VPN del equipo (Surfshark USA)') });
        if (o.rotateVpn !== false) {
            const rot = await cycleDeviceVpn(batch.adb, device);
            batchNotify(sender, 'log', { texto: '  [vpn] ' + rot });
        }
        const push = (name, value) => { args.push(name); args.push('"' + String(value) + '"'); };

        push('-Email', p.email || '');
        // El script usa el adb del PATH: se antepone la carpeta del que hemos encontrado.
        args.push('-Serial');
        args.push('"' + (p.serial || '') + '"');

        if (!p.skipDob) {
            if (p.dobMode === 'random') {
                args.push('-RandomAdultBirthday');
            } else if (p.dobDate) {
                const parts = String(p.dobDate).split('-');
                if (parts.length === 3) {
                    args.push('-BirthYear'); args.push(parts[0]);
                    args.push('-BirthMonth'); args.push(parts[1]);
                    args.push('-BirthDay'); args.push(parts[2]);
                }
            }
        }
        if (p.randomGender) args.push('-RandomGender');
        if (p.submit) args.push('-SubmitSignup');

        const artists = (p.artists || '')
            .split(',')
            .map((a) => a.trim())
            .filter((a) => a.length > 0);
        if (artists.length > 0) {
            // La lista va como un solo argumento con comas: PowerShell la expande
            // a string[] sin romper ningun nombre de artista.
            push('-Artists', artists.join(','));
        }
        args.push('-MinArtists');
        args.push(String(p.minArtists == null ? 3 : p.minArtists));

        const env = Object.assign({}, process.env);
        env.SPOTIFY_SIGNUP_GUI = '1';
        env.SPOTIFY_SIGNUP_PASSWORD = p.password || '';
        env[Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path'] = pathWithAdb();

        automatProc = spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args),
            { cwd: appPath, env: env, windowsHide: true }
        );

        automatProc.stdout.setEncoding('utf8');
        automatProc.stderr.setEncoding('utf8');
        automatProc.stdout.on('data', (buf) => {
            if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('automat-signup-log', String(buf));
            }
        });
        automatProc.stderr.on('data', (buf) => {
            if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('automat-signup-log', String(buf));
            }
        });
        automatProc.on('error', (err) => {
            if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('automat-signup-log', '\nError al arrancar PowerShell: ' + err.message + '\n');
            }
            automatProc = null;
        });
        automatProc.on('close', (code) => {
            if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('automat-signup-done', { code });
            }
            automatProc = null;
        });

        return { ok: true, adb: adb, script: script };
    });

    ipcMain.handle('automat-signup-cancel', async () => {
        if (!automatProc || automatProc.killed) return { ok: true };
        try {
            if (!automatProc.killed) treeKill(automatProc.pid, 'SIGTERM', () => { });
        } catch (e) {
            try { automatProc.kill(); } catch (e2) { }
        }
        automatProc = null;
        return { ok: true };
    });

    // ---- Accountcreat: generador de correos ----

    let accountcreatProc = null;

    // El panel es editable, asi que lo que se guarda es el TEXTO tal cual lo deja
// el usuario, no una lista de correos: si se guardara la lista, al reabrir la
// app se perderian las ediciones.
function accountcreatStateFile() {
        return path.join(app.getPath('userData'), 'correos.json');
    }

    function readAccountcreatText() {
        try {
            const raw = fs.readFileSync(accountcreatStateFile(), 'utf8');
            const data = JSON.parse(raw);
            if (data && typeof data.text === 'string') return data.text;
        } catch (e) { }
        return '';
    }

    function writeAccountcreatText(text) {
        try {
            fs.writeFileSync(accountcreatStateFile(), JSON.stringify({ text: text }), 'utf8');
            return true;
        } catch (e) {
            console.error('[Accountcreat] no se pudo guardar:', e);
            return false;
        }
    }

    ipcMain.handle('accountcreat-load', async () => {
        return { ok: true, text: readAccountcreatText() };
    });

    ipcMain.handle('accountcreat-save-text', async (event, payload) => {
        const text = (payload && payload.text) || '';
        return { ok: writeAccountcreatText(text) };
    });

    ipcMain.handle('accountcreat-clear', async () => {
        writeAccountcreatText('');
        return { ok: true };
    });

    ipcMain.handle('accountcreat-run', async (event, payload) => {
        if (accountcreatProc && !accountcreatProc.killed) {
            return { ok: false, error: 'Ya se estan generando correos.' };
        }
        const collectedEmails = [];
        const script = path.join(appPath, 'Tools', 'Python_correos.py');
        if (!fs.existsSync(script)) {
            return { ok: false, error: 'No se encontro Python_correos.py en Tools\\.' };
        }

        const cantidad = parseInt((payload && payload.cantidad), 10);
        if (isNaN(cantidad) || cantidad < 1) {
            return { ok: false, error: 'Cantidad no valida.' };
        }
        // Tope para que un valor absurdo no bloquee la app generando sin fin.
        if (cantidad > 100000) {
            return { ok: false, error: 'La cantidad no puede superar 100000.' };
        }

        accountcreatProc = spawn('python', [script, String(cantidad)], {
            cwd: appPath,
            windowsHide: true
        });

        accountcreatProc.stdout.setEncoding('utf8');
        accountcreatProc.stderr.setEncoding('utf8');
        accountcreatProc.stdout.on('data', (buf) => {
            // Se acumulan aqui y no solo en el renderer: asi la lista se guarda
            // aunque el panel se cierre a mitad de la generacion.
            String(buf).split(/\r?\n/).forEach((line) => {
                const email = line.trim();
                if (email) collectedEmails.push(email);
            });
            if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('accountcreat-log', String(buf));
            }
        });
        accountcreatProc.stderr.on('data', (buf) => {
            if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('accountcreat-log', String(buf));
            }
        });
        accountcreatProc.on('error', (err) => {
            if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('accountcreat-log', '\nError al arrancar Python: ' + err.message + '\n');
            }
            accountcreatProc = null;
        });
        accountcreatProc.on('close', (code) => {
            // Se anade al texto que hubiera, enumerando desde donde acaba: las
            // generaciones anteriores y las ediciones del usuario se respetan.
            if (collectedEmails.length > 0) {
                const previo = readAccountcreatText();
                const lineas = previo.split('\n').filter((l) => l.trim().length > 0).length;
                const nuevos = collectedEmails.map((mail, i) => (lineas + i + 1) + '. ' + mail).join('\n');
                const unido = previo.trim().length > 0 ? previo.replace(/\s+$/, '') + '\n' + nuevos + '\n' : nuevos + '\n';
                writeAccountcreatText(unido);
            }
            if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('accountcreat-done', { code, total: collectedEmails.length });
            }
            accountcreatProc = null;
        });

        return { ok: true };
    });

    ipcMain.handle('accountcreat-cancel', async () => {
        if (!accountcreatProc || accountcreatProc.killed) return { ok: true };
        try {
            if (!accountcreatProc.killed) treeKill(accountcreatProc.pid, 'SIGTERM', () => { });
        } catch (e) {
            try { accountcreatProc.kill(); } catch (e2) { }
        }
        accountcreatProc = null;
        return { ok: true };
    });

    ipcMain.handle('accountcreat-save', async (event, payload) => {
        const content = (payload && payload.content) || '';
        if (!content.trim()) return { ok: false, error: 'No hay correos que guardar.' };
        try {
            const res = await dialog.showSaveDialog(event.sender.getOwnerBrowserWindow() || undefined, {
                title: 'Guardar correos',
                defaultPath: path.join(app.getPath('documents'), 'correos.txt'),
                filters: [{ name: 'Texto', extensions: ['txt'] }]
            });
            if (res.canceled || !res.filePath) return { ok: false, canceled: true };
            fs.writeFileSync(res.filePath, content, 'utf8');
            return { ok: true, path: res.filePath };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ---- Automat: lote de registros ----
    //
    // El script de registro sale con codigo 0 tanto si termino su recorrido como
    // si se detuvo en el CAPTCHA (ambos casos hacen 'return' sin exit). Por eso
    // el codigo de salida NO sirve para decidir si la cuenta quedo lista: hay
    // que mirar si el proceso escribio el aviso de CAPTCHA.

    const CAPTCHA_MARK = '== CAPTCHA ==';

    const USA_CITIES = ['new york', 'los angeles', 'chicago', 'dallas', 'miami', 'seattle', 'atlanta', 'denver', 'phoenix', 'las vegas', 'boston', 'houston', 'san francisco', 'washington', 'orlando', 'tampa', 'detroit', 'minneapolis', 'philadelphia', 'united states'];
    const RATE_LIMIT_MARKS = ['429', 'too many requests', 'rate limit', 'rate-limit', 'slow down', 'demasiadas solicitudes', 'demasiados intentos'];
    const BATCH_RESUME_FILE = path.join(app.getPath('userData'), 'batch_resume.json');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function batchProxiesFile() {
        return path.join(app.getPath('appData'), 'Spotifix', 'Spotify Mobile', 'Files', 'proxies.txt');
    }

    function loadBatchProxies() {
        try {
            if (!fs.existsSync(batchProxiesFile())) return [];
            return fs.readFileSync(batchProxiesFile(), 'utf8').split(/\r?\n/)
                .map((s) => s.trim()).filter((s) => s.length > 0 && s[0] !== '#');
        } catch (e) { return []; }
    }

    function getDiscordWebhook() {
        try {
            const f = path.join(app.getPath('appData'), 'Spotifix', 'Spotify Mobile', 'Files', 'settings.json');
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d && d.discordWebhook && String(d.discordWebhook).indexOf('https://discord.com/api/webhooks/') === 0) return d.discordWebhook;
        } catch (e) {}
        return null;
    }

    async function discordNotify(content) {
        const url = getDiscordWebhook();
        if (!url) return;
        try { await axios.post(url, { content: String(content).slice(0, 1900) }, { timeout: 15000 }); } catch (e) {}
    }

    function execOut(cmd, timeout) {
        return new Promise((resolve) => {
            exec(cmd, { windowsHide: true, timeout: timeout || 20000 }, (err, stdout) => {
                resolve({ err: err, out: String(stdout || '') });
            });
        });
    }

    let batchPrecheckGpsMsg = '';
    async function checkDeviceVpnUsa(adb, device) {
        try {
            const gps = path.join(appPath, 'Tools', 'surf_gps.py');
            const gout = await new Promise((resolve) => {
                exec('python "' + gps + '" "' + device + '"', { windowsHide: true, timeout: 180000 }, (err, stdout) => {
                    resolve(String(stdout || ''));
                });
            });
            const gm = gout.match(/GPS-(OK|FAIL)\s*(.*)/);
            if (gm) batchPrecheckGpsMsg = 'GPS override: ' + gm[1] + ' ' + (gm[2] || '');
        } catch (e) { batchPrecheckGpsMsg = 'GPS override: no verificado'; }

        const route = await execOut('"' + adb + '" -s "' + device + '" shell ip route', 15000);
        if (route.out.indexOf('tun') === -1) {
            return { ok: false, detalle: device + ': sin VPN (no hay interfaz tun). Enciende Surfshark en USA.' };
        }
        try {
            await execOut('"' + adb + '" -s "' + device + '" shell monkey -p com.surfshark.vpnclient.android -c android.intent.category.LAUNCHER 1', 20000);
        } catch (e) {}
        await sleep(5000);
        const dump = await execOut('"' + adb + '" -s "' + device + '" shell uiautomator dump /sdcard/_vpn.xml', 20000);
        const cat = await execOut('"' + adb + '" -s "' + device + '" shell cat /sdcard/_vpn.xml', 15000);
        await execOut('"' + adb + '" -s "' + device + '" shell rm -f /sdcard/_vpn.xml', 10000);
        const txt = (cat.out || '').toLowerCase();
        const connected = txt.indexOf('connected') !== -1 || txt.indexOf('conectado') !== -1;
        const usa = USA_CITIES.some((c) => txt.indexOf(c) !== -1);
        if (!connected) return { ok: false, detalle: device + ': Surfshark no muestra Connected. Abrelo y conecta USA.' };
        if (!usa) return { ok: false, detalle: device + ': VPN activa pero no se confirma USA. Conecta un servidor USA.' };
        return { ok: true, detalle: device + ': VPN USA verificada.' };
    }

    async function checkCapsolverBalance() {
        try {
            const reg = await axios.post('http://127.0.0.1:8999/register', { username: 'local' }, { timeout: 15000 });
            const token = reg.data && reg.data.token;
            if (!token) return { ok: false, detalle: 'Backend sin token' };
            const b = await axios.get('http://127.0.0.1:8999/capsolver_balance', { headers: { Authorization: 'Bearer ' + token }, timeout: 25000 });
            if (b.data && b.data.balance !== undefined) return { ok: true, balance: b.data.balance };
            return { ok: false, detalle: (b.data && b.data.error) || 'Sin saldo' };
        } catch (e) { return { ok: false, detalle: 'CapSolver: ' + e.message }; }
    }

    async function checkProxyUsa(line) {
        const parts = String(line).split(':');
        if (parts.length < 2) return { ok: false, detalle: 'Formato invalido (usa host:puerto[:user:pass])' };
        const host = parts[0].trim(), port = parseInt(parts[1], 10);
        if (!host || isNaN(port)) return { ok: false, detalle: 'Formato invalido' };
        const cfg = { host: host, port: port };
        if (parts[2]) cfg.auth = { username: parts[2], password: parts[3] || '' };
        try {
            const res = await axios.get('http://ip-api.com/json/', { proxy: cfg, timeout: 15000 });
            const d = res.data || {};
            if (d.countryCode === 'US') return { ok: true, detalle: (d.city || '') + ' ' + (d.query || '') };
            return { ok: false, detalle: 'No es USA: ' + (d.country || '?') + ' ' + (d.query || '') };
        } catch (e) { return { ok: false, detalle: 'Sin conexion: ' + e.message }; }
    }

    async function batchPrecheck(adb, devices) {
        const lines = [];
        const bal = await checkCapsolverBalance();
        lines.push('  [capsolver] saldo: ' + (bal.ok ? ('$' + bal.balance) : bal.detalle));
        if (!bal.ok) return { ok: false, error: 'CapSolver: ' + bal.detalle, report: lines.join('\n') };
        return { ok: true, report: lines.join('\n'), proxies: [] };
    }

    async function cycleDeviceVpn(adb, device) {
        const script = path.join(appPath, 'Tools', 'surf_rotate.py');
        const runOne = () => new Promise((resolve) => {
            exec('python "' + script + '" "' + device + '"', { windowsHide: true, timeout: 600000 }, (err, stdout) => {
                resolve(String(stdout || '') + (err ? '\nERR:' + err.message : ''));
            });
        });
        try {
            const out = await runOne();
            const m = out.match(/SURF-OK\s+(\S+)\s+(\S+)\s+(\S+)/);
            if (m) {
                try {
                    const reg = await axios.post('http://127.0.0.1:8999/register', { username: 'local' }, { timeout: 15000 });
                    if (reg.data && reg.data.token) {
                        await axios.post('http://127.0.0.1:8999/device_vpn_set', { udid: device, location: m[1] + ', USA', ip: m[2], on: true }, { headers: { Authorization: 'Bearer ' + reg.data.token }, timeout: 15000 });
                    }
                } catch (e) {}
                return 'IP renovada USA (' + m[1] + ' ' + m[2] + ').';
            }
            const f = out.match(/SURF-FAIL\s+(.*)/);
            return 'sin cambio (' + ((f && f[1]) || 'ver log').trim().slice(0, 80) + '), se continua igual.';
        } catch (e) { return 'no se pudo rotar (' + e.message + '), se continua igual.'; }
    }

    function batchDocsDir() {
        const d = path.join(app.getPath('documents'), 'Spotifix');
        try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
        return d;
    }

    function exportBatchResults(items, resumen) {
        try {
            const now = new Date();
            const p = (n) => String(n).padStart(2, '0');
            const base = 'lote_' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + '_' + p(now.getHours()) + p(now.getMinutes());
            const csv = path.join(batchDocsDir(), base + '.csv');
            const txt = path.join(batchDocsDir(), base + '.txt');
            const rows = ['email;password;resultado;proxy;detalle;hora'];
            (items || []).forEach((it) => {
                const em = String(it.email || '').split(':')[0];
                const pw = String(it.email || '').split(':').slice(1).join(':') || it.password || '';
                rows.push([em, pw, it.resultado || '', it.proxy || '', String(it.detalle || '').replace(/;/g, ','), it.hora || ''].join(';'));
            });
            fs.writeFileSync(csv, rows.join('\n'), 'utf8');
            fs.writeFileSync(txt, resumen + '\n\n' + rows.slice(1).join('\n'), 'utf8');
            return 'Exportado: ' + csv;
        } catch (e) { return 'No se pudo exportar: ' + e.message; }
    }

    function saveBatchResume() {
        try {
            if (!batch) { return; }
            fs.writeFileSync(BATCH_RESUME_FILE, JSON.stringify({
                queue: batch.queue.slice(batch.index),
                total: batch.queue.length,
                done: batch.index,
                ok: batch.ok, captcha: batch.captcha, fail: batch.fail,
                items: batch.items, password: batch.password, opts: batch.opts,
                ts: Date.now()
            }), 'utf8');
        } catch (e) {}
    }

    function readBatchResume() {
        try {
            const d = JSON.parse(fs.readFileSync(BATCH_RESUME_FILE, 'utf8'));
            if (d && d.queue && d.queue.length) return d;
        } catch (e) {}
        return null;
    }

    function clearBatchResume() {
        try { fs.unlinkSync(BATCH_RESUME_FILE); } catch (e) {}
    }


    let batch = null;

    function batchNotify(sender, type, data) {
        if (sender && !sender.isDestroyed()) {
            sender.send('batch-event', { type: type, data: data });
        }
    }

    function runPythonEmails(cantidad) {
        return new Promise((resolve) => {
            const script = path.join(appPath, 'Tools', 'Python_correos.py');
            if (!fs.existsSync(script)) {
                resolve({ ok: false, error: 'No se encontro Python_correos.py en Tools\\.' });
                return;
            }
            const p = spawn('python', [script, String(cantidad)], { cwd: appPath, windowsHide: true });
            let out = '';
            p.stdout.setEncoding('utf8');
            p.stderr.setEncoding('utf8');
            p.stdout.on('data', (b) => { out += b; });
            p.stderr.on('data', (b) => { out += b; });
            p.on('error', (err) => resolve({ ok: false, error: err.message }));
            p.on('close', () => {
                const emails = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.indexOf('@') !== -1);
                resolve({ ok: true, emails: emails });
            });
        });
    }

    // Las cuentas quedan anotadas como 'correo:contraseña'. Las que se quedaron en
    // CAPTCHA se marcan con un sufijo para poder distinguirlas: el bot no sabe si
    // Spotify llegó a crearlas, asi que se anotan pero no cuentan como confirmadas.
    function appendBatchResult(email, password, resultado) {
        const previo = readAccountcreatText();
        const marca = resultado === 'captcha' ? ' (verificar)' : '';
        const linea = email + ':' + password + marca;
        const unido = previo.trim().length > 0 ? previo.replace(/\s+$/, '') + '\n' + linea + '\n' : linea + '\n';
        writeAccountcreatText(unido);
        return unido;
    }

    // Cierra la sesion de la cuenta anterior en el movil.
    //
    // Sin esto, la segunda cuenta falla: el script arranca en el paso 1 buscando
    // el boton 'Registrarse gratis', que no existe si el dispositivo sigue dentro
    // de la cuenta anterior, y el registro muere tras ~15 s de reintentos.
    //
    // 'pm clear' deja la app como recien instalada (borra la sesion y el estado
    // del onboarding) sin tocar el APK. Si adb no esta disponible no se interrumpe
    // el lote: se avisa y el script decides el.
    function logoutDevice(adb, device) {
        return new Promise((resolve) => {
            if (!adb || !device) { resolve(false); return; }
            const serie = '"' + String(device) + '"';
            exec('"' + adb + '" -s ' + serie + ' shell am force-stop com.spotify.music', { windowsHide: true, timeout: 60000 }, () => {
                exec('"' + adb + '" -s ' + serie + ' shell pm clear com.spotify.music', { windowsHide: true, timeout: 90000 }, (err) => {
                    resolve(!err);
                });
            });
        });
    }

    function batchSender() {
        return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    }

    async function batchRunNext() {
        if (!batch || batch.stopped || batch.paused) return;
        // Un solo registro a la vez: si se solapasen dos, los 'input tap' del
        // segundo machacarian la pantalla del primero.
        if (batch.proc) return;

        if (batch.index >= batch.queue.length) {
            const bfin = batch;
            const resumen = 'Lote terminado: ' + bfin.ok + ' correcto(s), ' +
                bfin.captcha + ' con CAPTCHA, ' + bfin.fail + ' con error.';
            const expfin = exportBatchResults(bfin.items, resumen);
            batchNotify(batchSender(), 'log', { texto: '  [export] ' + expfin });
            discordNotify('Spotifix ' + resumen + '\n' + expfin);
            clearBatchResume();
            batch = null;
            const s = batchSender();
            batchNotify(s, 'finished', { resumen: resumen });
            return;
        }

        const email = batch.queue[batch.index];
        const device = batch.devices.length > 0
            ? batch.devices[batch.deviceIdx % batch.devices.length]
            : null;
        if (batch.devices.length > 0) batch.deviceIdx++;

        if (!device) {
            batch.fail++;
            batch.index++;
            batchNotify(batchSender(), 'item', {
                email: email, device: null, resultado: 'error',
                detalle: 'No hay dispositivos adb conectados.'
            });
            setTimeout(() => { batchRunNext(); }, 200);
            return;
        }

        const o = batch.opts;
        const args = [];

        // Antes de cada cuenta se cierra la sesion de la anterior en el movil.
        // Se hace fuera del try para que un fallo aqui no impida lanzar el registro.
        try {
            const limpio = await logoutDevice(batch.adb, device);
            batchNotify(batchSender(), 'log', {
                texto: limpio
                    ? '  [logout] ' + device + ': sesion anterior cerrada (pm clear)'
                    : '  [logout] ' + device + ': no se pudo cerrar la sesion, se continua igualmente'
            });
        } catch (e) {
            batchNotify(batchSender(), 'log', { texto: '  [logout] aviso: ' + e.message });
        }

        const push = (name, value) => { args.push(name); args.push('"' + String(value) + '"'); };
        push('-Email', email);
        args.push('-Serial'); args.push('"' + device + '"');
        if (!o.skipDob) {
            if (o.dobMode === 'random') {
                args.push('-RandomAdultBirthday');
            } else if (o.dobDate) {
                const parts = String(o.dobDate).split('-');
                if (parts.length === 3) {
                    args.push('-BirthYear'); args.push(parts[0]);
                    args.push('-BirthMonth'); args.push(parts[1]);
                    args.push('-BirthDay'); args.push(parts[2]);
                }
            }
        }
        if (o.randomGender) args.push('-RandomGender');
        if (o.submit) args.push('-SubmitSignup');
        const artists = (o.artists || '').split(',').map((a) => a.trim()).filter((a) => a.length > 0);
        if (artists.length > 0) push('-Artists', artists.join(','));
        args.push('-MinArtists');
        args.push(String(o.minArtists == null ? 3 : o.minArtists));

        const env = Object.assign({}, process.env);
        env.SPOTIFY_SIGNUP_GUI = '1';
        env.SPOTIFY_SIGNUP_PASSWORD = batch.password;
        env[Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path'] = pathWithAdb();

        const sender = batchSender();
        batchNotify(sender, 'item-start', {
            email: email, device: device,
            indice: batch.index + 1, total: batch.queue.length
        });

        const proc = spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                path.join(appPath, 'Tools', 'spotify-signup.ps1')].concat(args),
            { cwd: appPath, env: env, windowsHide: true }
        );
        batch.proc = proc;
        batch.sawCaptcha = false;

        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        const onData = (buf) => {
            const s = String(buf);
            if (s.indexOf(CAPTCHA_MARK) !== -1) batch.sawCaptcha = true;
            if (RATE_LIMIT_MARKS.some((mk) => s.toLowerCase().indexOf(mk) !== -1)) batch.rateHits = (batch.rateHits || 0) + 1;
            batchNotify(sender, 'log', s);
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);

        proc.on('error', (err) => {
            batchNotify(sender, 'log', '\nError al arrancar PowerShell: ' + err.message + '\n');
            if (batch) { batch.proc = null; }
        });

        proc.on('close', (code) => {
            if (!batch || batch.proc !== proc) return;
            batch.proc = null;
            const emailUsed = email;
            let resultado, detalle;

            if (code !== 0) {
                batch.fail++;
                resultado = 'error';
                detalle = 'El script fallo (codigo ' + code + '). El error esta arriba en el log.';
            } else if (batch.sawCaptcha) {
                batch.captcha++;
                resultado = 'captcha';
                detalle = 'Spotify pidio verificacion humana. Resuelvela en el movil y pulsa Continuar.';
                // Se anota igualmente: si el reto se resuelve a mano la cuenta
                // puede quedar creada, y asi no se pierde su contrasena. Lleva el
                // sufijo '(verificar)' para distinguirlas de las confirmadas.
                appendBatchResult(emailUsed, batch.password, 'captcha');
                // Se para el lote: la cuenta siguiente se registraria en la
                // pantalla del reto y el script no podria ni leerla.
                batch.paused = true;
            } else {
                batch.ok++;
                resultado = 'ok';
                detalle = '';
                appendBatchResult(emailUsed, batch.password, 'ok');
            }

            batchNotify(sender, 'item', {
                email: emailUsed, device: device, resultado: resultado, detalle: detalle
            });

            batch.items.push({ email: emailUsed, resultado: resultado, detalle: detalle, proxy: (typeof cuentaProxy !== 'undefined' && cuentaProxy) ? cuentaProxy.label : 'vpn-equipo', hora: new Date().toISOString() });
            if (resultado === 'error') { batch.failStreak++; } else if (resultado === 'ok') { batch.failStreak = 0; }
            saveBatchResume();
            if (batch.failStreak >= 3) {
                batch.failStreak = 0;
                batch.paused = true;
                batchNotify(sender, 'phase', 'Pausa automatica: 3 errores seguidos (posible rate-limit). Reanuda sola en 15 min.');
                batchNotify(sender, 'log', { texto: '  [rate-limit] pausa automatica 15 min' });
                discordNotify('Spotifix: pausa automatica por 3 errores seguidos. Reanuda sola en 15 min.');
                if (batch.rateTimer) clearTimeout(batch.rateTimer);
                batch.rateTimer = setTimeout(() => {
                    if (batch && batch.paused && !batch.stopped) {
                        batch.paused = false;
                        batchNotify(batchSender(), 'phase', 'Reanudando tras pausa automatica...');
                        discordNotify('Spotifix: reanudando lote tras pausa automatica.');
                        batchRunNext();
                    }
                }, 15 * 60 * 1000);
            }
            batch.index++;
            if (!batch.paused) {
                setTimeout(() => { batchRunNext(); }, 300);
            }
        });
    }

    ipcMain.handle('batch-start', async (event, payload) => {
        if (batch) return { ok: false, error: 'Ya hay un lote en marcha.' };

        const p = payload || {};
        const cantidad = parseInt(p.cantidad, 10);
        if (isNaN(cantidad) || cantidad < 1) return { ok: false, error: 'Cantidad no valida.' };
        if (cantidad > 10000) return { ok: false, error: 'La cantidad no puede superar 10000.' };
        if (!p.password) return { ok: false, error: 'Escribe la contrasena.' };

        const sender = batchSender();
        batchNotify(sender, 'phase', 'Generando ' + cantidad + ' correo(s)...');

        const gen = await runPythonEmails(cantidad);
        if (!gen.ok) return { ok: false, error: gen.error };
        if (gen.emails.length === 0) {
            return { ok: false, error: 'No se genero ningun correo.' };
        }

        const adb = findAdb();
        if (!adb) return { ok: false, error: "No se encontro 'adb.exe'." };

        const devices = await new Promise((resolve) => {
            exec('"' + adb + '" devices', { windowsHide: true, timeout: 20000 }, (err, stdout) => {
                const list = [];
                String(stdout || '').split(/\r?\n/).forEach((raw) => {
                    const line = raw.trim();
                    if (!line || line.startsWith('List of devices') || line.startsWith('*')) return;
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2 && parts[1] === 'device') list.push(parts[0]);
                });
                resolve(list);
            });
        });
        if (devices.length === 0) {
            return { ok: false, error: 'adb no ve ningun telefono listo.' };
        }

        batchNotify(sender, 'phase', 'Prechequeo: VPN USA + saldo CapSolver...');
        const pre = await batchPrecheck(adb, devices);
        batchNotify(sender, 'log', { texto: pre.report });
        if (!pre.ok) {
            batchNotify(sender, 'phase', 'Prechequeo fallido.');
            discordNotify('Spotifix lote NO iniciado. Prechequeo fallido:\n' + pre.error);
            return { ok: false, error: pre.error };
        }

        batch = {
            queue: gen.emails,
            index: 0,
            devices: devices,
            deviceIdx: 0,
            adb: findAdb(),
            password: p.password,
            opts: p.opts || {},
            paused: false,
            stopped: false,
            proc: null,
            sawCaptcha: false,
            ok: 0,
            captcha: 0,
            fail: 0,
            proxies: pre.proxies,
            items: [],
            failStreak: 0,
            rateHits: 0,
            rateTimer: null
        };

        batchNotify(sender, 'phase', 'Lote iniciado: ' + gen.emails.length +
            ' correo(s) en ' + devices.length + ' dispositivo(s).');
        batchNotify(sender, 'summary', { ok: 0, captcha: 0, fail: 0, total: gen.emails.length });
        discordNotify('Spotifix lote iniciado: ' + gen.emails.length + ' cuenta(s) en ' + devices.length + ' dispositivo(s).');
        saveBatchResume();

        batchRunNext();
        return { ok: true, total: gen.emails.length, devices: devices };
    });

    ipcMain.handle('batch-continue', async () => {
        if (!batch) return { ok: false, error: 'No hay ningun lote en marcha.' };
        if (!batch.paused) return { ok: true };
        batch.paused = false;
        const sender = batchSender();
        batchNotify(sender, 'phase', 'Continuando con la siguiente cuenta...');
        batchRunNext();
        return { ok: true };
    });

    ipcMain.handle('batch-stop', async () => {
        if (!batch) return { ok: true };
        batch.stopped = true;
        batch.paused = false;
        if (batch.proc && !batch.proc.killed) {
            try { treeKill(batch.proc.pid, 'SIGTERM', () => { }); } catch (e) { }
        }
        batch.proc = null;
        const bstop = batch;
        const resumen = 'Lote detenido. ' + bstop.ok + ' correcto(s), ' +
            bstop.captcha + ' con CAPTCHA, ' + bstop.fail + ' con error.';
        const total = bstop.index;
        const expstop = exportBatchResults(bstop.items, resumen);
        if (bstop.rateTimer) clearTimeout(bstop.rateTimer);
        discordNotify('Spotifix ' + resumen + '\n' + expstop);
        batch = null;
        batchNotify(batchSender(), 'finished', { resumen: resumen + ' ' + expstop, parcial: true, total: total });
        return { ok: true };
    });

    app.on('before-quit', () => {
        if (automatProc && !automatProc.killed) {
            try { treeKill(automatProc.pid, 'SIGTERM', () => { }); } catch (e) { }
        }
        if (accountcreatProc && !accountcreatProc.killed) {
            try { treeKill(accountcreatProc.pid, 'SIGTERM', () => { }); } catch (e) { }
        }
    });

    app.on('ready', async () => {
        const restartFlag = path.join(appPath, '_update_restart');
        try { if (fs.existsSync(restartFlag)) fs.unlinkSync(restartFlag); } catch (e) {}
        killProcessOnPort(8999);
        backendProcess = spawnBackend();
        spawnAIServer();

        createSplashScreen();

        try {
            await waitForBackendReady();
            console.log('Backend is ready');
        } catch (error) {
            console.error('An error occurred:', error);
        }

        startBackendHealthCheck();
        if (isAuthenticated()) {
            proceedToMain();
        } else {
            createLoginWindow();
        }
    });

    async function proceedToMain() {
        const token = await autoLogin();
        if (loginWindow) {
            loginWindow.close();
        }
        createMainWindow(token);
        createTray();
    }

    ipcMain.on('login-success', (event) => {
        markAuthenticated();
        proceedToMain();
    });

    function cleanUpAndQuit() {
        console.log('Cleaning up before quitting...');
        if (aiServerProcess && !aiServerProcess.killed) {
            treeKill(aiServerProcess.pid, 'SIGTERM', () => {});
            aiServerProcess = null;
        }
        if (backendHealthInterval) {
            clearInterval(backendHealthInterval);
            backendHealthInterval = null;
        }
        if (backendProcess && !backendProcess.killed) {
            treeKill(backendProcess.pid, 'SIGTERM', (err) => {
                if (err) {
                    console.error('Failed to kill backend process:', err);
                } else {
                    console.log('Backend process terminated.');
                }
                backendProcess = null;
                app.quit();
            });
        } else {
            app.quit();
        }
    }
}


