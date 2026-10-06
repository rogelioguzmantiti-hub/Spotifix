const { contextBridge, ipcRenderer } = require('electron');

// Define allowed channels for send and receive to ensure security
const validSendChannels = ['toggle-console', 'toggle-always-on-top', 'minimize-app', 'close-app', 'send-token', 'login-attempt', 'login-success', 'restart-app'];
const validInvokeChannels = ['ai-status', 'ai-chat', 'ai-reset', 'automat-adb-devices', 'automat-signup-start', 'automat-signup-cancel', 'accountcreat-run', 'accountcreat-cancel', 'accountcreat-save', 'accountcreat-load', 'accountcreat-save-text', 'accountcreat-clear', 'batch-start', 'batch-continue', 'batch-stop', 'batch-export', 'batch-resume', 'batch-resume-info'];
const validReceiveChannels = ['console-toggled', 'token-received', 'login-response', 'ai-progress', 'automat-signup-log', 'automat-signup-done', 'accountcreat-log', 'accountcreat-done', 'batch-event'];

contextBridge.exposeInMainWorld('electronAPI', {
    saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
    loadSettings: () => ipcRenderer.invoke('load-settings'),
    toggleAlwaysOnTop: (isOnTop) => {
        if (validSendChannels.includes('toggle-always-on-top')) {
            ipcRenderer.send('toggle-always-on-top', isOnTop);
        }
    },
    minimizeApp: () => {
        if (validSendChannels.includes('minimize-app')) {
            ipcRenderer.send('minimize-app');
        }
    },
    closeApp: () => {
        if (validSendChannels.includes('close-app')) {
            ipcRenderer.send('close-app');
        }
    },
    restartApp: () => {
        ipcRenderer.send('restart-app');
    },
    sendTokenToRenderer: (token) => {
        if (validSendChannels.includes('send-token')) {
            ipcRenderer.send('send-token', token);
        }
    },
    onTokenReceived: (callback) => {
        if (validReceiveChannels.includes('token-received')) {
            ipcRenderer.on('token-received', (event, token) => callback(token));
        }
    },
    onAiProgress: (callback) => {
        if (validReceiveChannels.includes('ai-progress')) {
            const listener = (event, progress) => callback(progress);
            ipcRenderer.on('ai-progress', listener);
            return () => ipcRenderer.removeListener('ai-progress', listener);
        }
        return null;
    },
    send: (channel, data) => {
        if (validSendChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    receive: (channel, func) => {
        if (validReceiveChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    },
    aiStatus: () => {
        if (validInvokeChannels.includes('ai-status')) {
            return ipcRenderer.invoke('ai-status');
        }
        return Promise.resolve({ ready: false, error: 'canal no permitido' });
    },
    aiChat: (payload) => {
        if (validInvokeChannels.includes('ai-chat')) {
            return ipcRenderer.invoke('ai-chat', payload);
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    aiReset: () => {
        if (validInvokeChannels.includes('ai-reset')) {
            return ipcRenderer.invoke('ai-reset');
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    automatDevices: () => {
        if (validInvokeChannels.includes('automat-adb-devices')) {
            return ipcRenderer.invoke('automat-adb-devices');
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    automatStart: (payload) => {
        if (validInvokeChannels.includes('automat-signup-start')) {
            return ipcRenderer.invoke('automat-signup-start', payload);
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    automatCancel: () => {
        if (validInvokeChannels.includes('automat-signup-cancel')) {
            return ipcRenderer.invoke('automat-signup-cancel');
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    onAutomatLog: (callback) => {
        if (validReceiveChannels.includes('automat-signup-log')) {
            const listener = (event, chunk) => callback(chunk);
            ipcRenderer.on('automat-signup-log', listener);
            return () => ipcRenderer.removeListener('automat-signup-log', listener);
        }
        return null;
    },
    onAutomatDone: (callback) => {
        if (validReceiveChannels.includes('automat-signup-done')) {
            const listener = (event, info) => callback(info);
            ipcRenderer.on('automat-signup-done', listener);
            return () => ipcRenderer.removeListener('automat-signup-done', listener);
        }
        return null;
    },
    accountcreatRun: (payload) => {
        if (validInvokeChannels.includes('accountcreat-run')) {
            return ipcRenderer.invoke('accountcreat-run', payload);
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    accountcreatCancel: () => {
        if (validInvokeChannels.includes('accountcreat-cancel')) {
            return ipcRenderer.invoke('accountcreat-cancel');
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    accountcreatSave: (payload) => {
        if (validInvokeChannels.includes('accountcreat-save')) {
            return ipcRenderer.invoke('accountcreat-save', payload);
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    accountcreatLoad: () => {
        if (validInvokeChannels.includes('accountcreat-load')) {
            return ipcRenderer.invoke('accountcreat-load');
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    accountcreatSaveText: (payload) => {
        if (validInvokeChannels.includes('accountcreat-save-text')) {
            return ipcRenderer.invoke('accountcreat-save-text', payload);
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    accountcreatClear: () => {
        if (validInvokeChannels.includes('accountcreat-clear')) {
            return ipcRenderer.invoke('accountcreat-clear');
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    onAccountcreatLog: (callback) => {
        if (validReceiveChannels.includes('accountcreat-log')) {
            const listener = (event, chunk) => callback(chunk);
            ipcRenderer.on('accountcreat-log', listener);
            return () => ipcRenderer.removeListener('accountcreat-log', listener);
        }
        return null;
    },
    onAccountcreatDone: (callback) => {
        if (validReceiveChannels.includes('accountcreat-done')) {
            const listener = (event, info) => callback(info);
            ipcRenderer.on('accountcreat-done', listener);
            return () => ipcRenderer.removeListener('accountcreat-done', listener);
        }
        return null;
    },
    batchStart: (payload) => {
        if (validInvokeChannels.includes('batch-start')) {
            return ipcRenderer.invoke('batch-start', payload);
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    batchContinue: () => {
        if (validInvokeChannels.includes('batch-continue')) {
            return ipcRenderer.invoke('batch-continue');
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    batchExport: () => {
        if (validInvokeChannels.includes('batch-export')) {
            return ipcRenderer.invoke('batch-export');
        }
        return Promise.resolve({ ok: false });
    },
    batchResume: () => {
        if (validInvokeChannels.includes('batch-resume')) {
            return ipcRenderer.invoke('batch-resume');
        }
        return Promise.resolve({ ok: false });
    },
    batchResumeInfo: () => {
        if (validInvokeChannels.includes('batch-resume-info')) {
            return ipcRenderer.invoke('batch-resume-info');
        }
        return Promise.resolve({ ok: true, pending: 0 });
    },
    batchStop: () => {
        if (validInvokeChannels.includes('batch-stop')) {
            return ipcRenderer.invoke('batch-stop');
        }
        return Promise.resolve({ ok: false, error: 'canal no permitido' });
    },
    onBatchEvent: (callback) => {
        if (validReceiveChannels.includes('batch-event')) {
            const listener = (event, payload) => callback(payload);
            ipcRenderer.on('batch-event', listener);
            return () => ipcRenderer.removeListener('batch-event', listener);
        }
        return null;
    }
});
