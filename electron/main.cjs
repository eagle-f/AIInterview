const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { CONFIG_KEYS, normalizeConfig, atomicWrite, validateCache } = require('./storage.cjs');

const development = !app.isPackaged && process.argv.includes('--dev');
const smoke = process.argv.includes('--smoke-test');
const projectRoot = path.join(__dirname, '..');
const settingsUrl = pathToFileURL(path.join(__dirname, 'settings.html')).href;
app.setName('AIInterview');
if (smoke) {
  if (!process.env.AIINTERVIEW_SMOKE_DIR) throw new Error('Smoke test requires an isolated data directory');
  app.setPath('userData', process.env.AIINTERVIEW_SMOKE_DIR);
} else if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'AIInterview-dev'));
}

const dataDir = app.getPath('userData');
const configFile = path.join(dataDir, 'api-config.enc');
const cacheFile = path.join(dataDir, 'current-interview.json');
let mainWindow;
let settingsWindow;
let backend;
let backendOrigin = '';
let frontendOrigin = '';
let accessToken = '';
let vite;
let viteProxy;
let quitting = false;
let savingSettings = false;
let reconnecting;
let loadedFrontendOrigin = '';

function readConfig() {
  if (fs.existsSync(configFile)) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥服务不可用，无法解密 API 配置');
    return normalizeConfig(JSON.parse(safeStorage.decryptString(fs.readFileSync(configFile))), false);
  }
  if (smoke) return normalizeConfig({}, false);
  // Local development may reuse .env files. They are never included in the installer.
  const input = {};
  if (development) {
    const { parse } = require('dotenv');
    for (const file of ['.env', '.env.local']) {
      const location = path.join(projectRoot, file);
      if (fs.existsSync(location)) Object.assign(input, parse(fs.readFileSync(location)));
    }
    for (const key of CONFIG_KEYS) if (process.env[key] !== undefined) input[key] = process.env[key];
  }
  return normalizeConfig(input, false);
}

function log(message) {
  try { fs.appendFileSync(path.join(dataDir, 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* logging must not break startup */ }
}

function stopBackend() {
  const child = backend;
  backend = undefined;
  child?.kill();
}

async function startBackend() {
  const config = readConfig();
  accessToken = randomBytes(32).toString('hex');
  const child = utilityProcess.fork(path.join(__dirname, 'backend-worker.cjs'), [], {
    cwd: dataDir,
    serviceName: 'AIInterview Backend',
    stdio: 'pipe',
    env: {
      ...process.env, ...config,
      AIINTERVIEW_DESKTOP: '1',
      AIINTERVIEW_DESKTOP_TOKEN: accessToken,
      AIINTERVIEW_DEV_ORIGIN: development ? 'http://127.0.0.1:4399' : '',
      HOST: '127.0.0.1', PORT: '0',
      INTERVIEW_DATA_DIR: path.join(dataDir, 'sessions'),
      AIINTERVIEW_STATIC_DIR: development ? '' : path.join(projectRoot, 'dist'),
    },
  });
  backend = child;
  const redact = (chunk) => {
    let text = chunk.toString();
    for (const key of CONFIG_KEYS.filter((name) => name.endsWith('_KEY'))) {
      if (config[key]) text = text.split(config[key]).join('[redacted]');
    }
    return text.trimEnd();
  };
  child.stdout?.on('data', (chunk) => log(redact(chunk)));
  child.stderr?.on('data', (chunk) => log(redact(chunk)));
  await new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { stopBackend(); reject(new Error('内置后端启动超时，请查看 desktop.log')); }, 20_000);
    child.on('message', (message) => {
      if (message.type === 'ready') {
        ready = true;
        clearTimeout(timer);
        backendOrigin = `http://127.0.0.1:${message.port}`;
        resolve();
      } else if (message.type === 'startup-error') {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`内置后端退出（${code}），请查看 desktop.log`));
      else if (backend === child && !quitting) {
        backend = undefined;
        log(`Backend exited unexpectedly (${code})`);
        dialog.showErrorBox('面试服务已停止', '记录已保留。请通过“应用 → 重新连接后端”恢复服务。');
      }
    });
  });
}

async function startVite() {
  const { createServer } = await import('vite');
  vite = await createServer({
    root: projectRoot,
    server: {
      host: '127.0.0.1', port: 4399, strictPort: true,
      proxy: { '/api': {
        target: backendOrigin, ws: true,
        headers: { 'x-aiinterview-token': accessToken },
        rewrite: (url) => url, // Desktop backend already supports /api.
        configure: (proxy) => { viteProxy = proxy; },
      } },
    },
  });
  await vite.listen();
}

function reconnect() {
  if (reconnecting) return reconnecting;
  reconnecting = (async () => {
    stopBackend();
    await startBackend();
    if (development) {
      if (!vite) await startVite();
      else {
        // Keep Vite/HMR alive; only the internal API target and token change.
        viteProxy.options.target = backendOrigin;
        viteProxy.options.headers['x-aiinterview-token'] = accessToken;
      }
    }
    frontendOrigin = development ? 'http://127.0.0.1:4399' : backendOrigin;
    await mainWindow.loadURL(`${frontendOrigin}/`);
  })().finally(() => { reconnecting = undefined; });
  return reconnecting;
}

function trustedMain(event) {
  return mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame &&
    loadedFrontendOrigin && event.senderFrame.url.startsWith(`${loadedFrontendOrigin}/`);
}
function trustedSettings(event) {
  return settingsWindow && event.sender === settingsWindow.webContents && event.senderFrame?.url === settingsUrl;
}

function configureSession() {
  // Renderer code receives no token. Electron adds it only to our backend requests.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url);
    const target = backendOrigin ? new URL(backendOrigin) : null;
    if (target && url.hostname === target.hostname && url.port === target.port &&
        ['http:', 'ws:'].includes(url.protocol) && details.webContentsId === mainWindow?.webContents.id) {
      details.requestHeaders['X-AIInterview-Token'] = accessToken;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  const isMainPage = (contents, origin) => contents === mainWindow?.webContents &&
    contents.getURL().startsWith(`${frontendOrigin}/`) && (!origin || origin.startsWith(`${frontendOrigin}/`) || origin === frontendOrigin);
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    isMainPage(contents, origin) && permission === 'media' && details.mediaType === 'audio');
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isMainPage(contents, details.requestingUrl) && permission === 'media' &&
      details.mediaTypes?.length > 0 && details.mediaTypes.every((type) => type === 'audio'));
  });
}

function restrictNavigation(window, allow) {
  window.webContents.on('will-navigate', (event, url) => { if (!allow(url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!allow(url)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function openSettings() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    title: 'API 设置 · AIInterview', width: 720, height: 900, minWidth: 620, minHeight: 600,
    parent: mainWindow, show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: !smoke },
  });
  restrictNavigation(settingsWindow, (url) => url === settingsUrl);
  settingsWindow.once('ready-to-show', () => { if (!smoke) settingsWindow?.show(); });
  settingsWindow.on('closed', () => { settingsWindow = undefined; });
  return settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
}

function configureIpc() {
  ipcMain.on('interview-cache', (event, operation, value) => {
    try {
      if (!trustedMain(event)) throw new Error('此页面无权访问面试缓存');
      if (operation === 'read') {
        const saved = fs.existsSync(cacheFile) ? validateCache(fs.readFileSync(cacheFile, 'utf8')) : null;
        event.returnValue = { ok: true, value: saved };
        return;
      }
      if (operation === 'write') atomicWrite(cacheFile, validateCache(value));
      else if (operation === 'clear') fs.rmSync(cacheFile, { force: true });
      else throw new Error('未知的缓存操作');
      event.returnValue = { ok: true };
    } catch (error) { event.returnValue = { ok: false, message: error.message }; }
  });
  ipcMain.handle('api-settings-read', (event) => {
    try {
      if (!trustedSettings(event)) throw new Error('此页面无权读取 API 设置');
      return { ok: true, config: readConfig() };
    } catch (error) { return { ok: false, message: error.message }; }
  });
  ipcMain.handle('api-settings-save', async (event, input) => {
    try {
      if (!trustedSettings(event)) throw new Error('此页面无权修改 API 设置');
      if (savingSettings) throw new Error('正在重新连接，请稍候');
      const config = normalizeConfig(input);
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
        throw new Error('系统密钥服务不可用，暂时无法安全保存 API 配置');
      }
      savingSettings = true;
      await reconnecting;
      atomicWrite(configFile, safeStorage.encryptString(JSON.stringify(config)));
      await reconnect();
      return { ok: true };
    } catch (error) { return { ok: false, message: error.message }; }
    finally { savingSettings = false; }
  });
}

async function runSmokeTest() {
  const evaluate = (code) => mainWindow.webContents.executeJavaScript(code);
  const waitFor = async (code) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Desktop UI did not reach expected state: ${code}`);
  };
  const capture = async (window, name) => {
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(dataDir, `${name}-preview.png`), (await window.webContents.capturePage()).toPNG());
  };
  const renderer = await evaluate(`({ title: document.title, mounted: !!document.querySelector('#app')?.children.length, node: typeof require, bridge: typeof window.desktopSession?.read, secure: window.isSecureContext })`);
  if (!renderer.mounted || renderer.node !== 'undefined' || renderer.bridge !== 'function' || !renderer.secure) throw new Error('Renderer or preload failed');
  const health = await evaluate(`fetch('/api/health').then(r => r.json())`);
  if (health.status !== 'ok') throw new Error('Desktop API request failed');
  if ((await fetch(`${backendOrigin}/api/health`)).status !== 403) throw new Error('Backend did not reject unauthenticated requests');
  const testWebSocket = () => evaluate(`new Promise((resolve, reject) => {
    const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/api/asr');
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket timeout')); }, 5000);
    socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(JSON.parse(event.data).type); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
  })`);
  const ws = await testWebSocket();
  if (ws !== 'asr_error') throw new Error('Missing speech config should return an actionable error');
  await waitFor(`!!document.querySelector('.setup-dialog[open]') && !!document.querySelector('#setup-resume')`);
  if (await evaluate(`!document.querySelector('.setup-submit').disabled || !!document.querySelector('.send-button')`)) throw new Error('Interview must wait for resume setup');
  // A real Vue input change exercises the application's cache watcher and reload recovery.
  await evaluate(`(() => { const input = document.querySelector('textarea'); if (!input) throw new Error('Input missing'); input.value = 'desktop-smoke-draft'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('.close-button').click()`);
  await waitFor(`!document.querySelector('.setup-dialog') && !document.querySelector('.send-button')`);
  await evaluate(`document.querySelector('.report-status .finish-button').click()`);
  await waitFor(`document.querySelector('#setup-resume')?.value === 'desktop-smoke-draft'`);
  const oldOrigin = backendOrigin;
  await reconnect();
  const restored = await evaluate(`document.querySelector('textarea')?.value`);
  if (restored !== 'desktop-smoke-draft') throw new Error('Draft did not survive backend restart / origin change');
  if (await evaluate(`JSON.parse(window.desktopSession.read()).timeline !== 0`)) throw new Error('Setup should not start the timer');

  // Synthetic Chromium devices verify permission handling without recording a real microphone.
  const microphone = await evaluate(`navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const kinds = stream.getTracks().map(track => track.kind); stream.getTracks().forEach(track => track.stop()); return kinds;
  })`);
  if (microphone.join(',') !== 'audio') throw new Error('Audio permission failed');
  const cameraDenied = await evaluate(`navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
    stream.getTracks().forEach(track => track.stop()); return false;
  }).catch(error => error.name === 'NotAllowedError')`);
  if (!cameraDenied) throw new Error('Camera permission was not denied');

  const modelBase = process.env.AIINTERVIEW_SMOKE_MODEL_BASE;
  if (!modelBase || new URL(modelBase).hostname !== '127.0.0.1') throw new Error('Smoke model must be local');
  await openSettings();
  const settingEvaluate = (code) => settingsWindow.webContents.executeJavaScript(code);
  const invalid = await settingEvaluate(`window.apiSettings.save({})`);
  if (invalid.ok) throw new Error('Settings accepted missing model configuration');
  const fixture = { DEEPSEEK_API_KEY: 'desktop-fixture-secret', BASE_URL: modelBase, AI_MODEL: 'desktop-fixture' };
  const saved = await settingEvaluate(`window.apiSettings.save(${JSON.stringify(fixture)})`);
  if (!saved.ok) throw new Error(saved.message);
  if (await testWebSocket() !== 'asr_error') throw new Error('WebSocket did not reconnect to the new backend');
  const loaded = await settingEvaluate(`window.apiSettings.read()`);
  const encrypted = fs.readFileSync(configFile);
  if (loaded.config.DEEPSEEK_API_KEY !== fixture.DEEPSEEK_API_KEY || encrypted.includes(Buffer.from(fixture.DEEPSEEK_API_KEY))) {
    throw new Error('Settings encryption / decryption failed');
  }
  settingsWindow.webContents.reload();
  // reload() is fire-and-forget; wait for the page and async settings preload to finish.
  await new Promise((resolve) => settingsWindow.webContents.once('did-finish-load', resolve));
  const filled = await settingEvaluate(`window.apiSettings.read().then(() => document.querySelector('[name="AI_MODEL"]').value)`);
  if (filled !== fixture.AI_MODEL) throw new Error('Settings form did not restore saved values');
  await capture(settingsWindow, 'settings');
  settingsWindow.close();

  // Setup steps retain both fields, and only successful opening enables answering.
  await waitFor(`!!document.querySelector('#setup-resume') && !document.querySelector('.setup-submit').disabled`);
  await evaluate(`(() => { const input = document.querySelector('#setup-resume'); input.value = '我负责组件库维护，熟悉 Vue 与回归测试。'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('.setup-submit').click()`);
  await waitFor(`!!document.querySelector('#setup-jd')`);
  await evaluate(`(() => { const input = document.querySelector('#setup-jd'); input.value = '组件平台工程师：Vue、组件设计与自动化测试。'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await reconnect();
  await waitFor(`document.querySelector('#setup-jd')?.value === '组件平台工程师：Vue、组件设计与自动化测试。' && !document.querySelector('.setup-submit').disabled`);
  await evaluate(`document.querySelector('.back-button').click()`);
  await waitFor(`document.querySelector('#setup-resume')?.value === '我负责组件库维护，熟悉 Vue 与回归测试。'`);
  await evaluate(`document.querySelector('.setup-submit').click()`);
  await waitFor(`document.querySelector('#setup-jd')?.value === '组件平台工程师：Vue、组件设计与自动化测试。'`);
  await capture(mainWindow, 'setup');
  await evaluate(`document.querySelector('.setup-submit').click()`);
  await waitFor(`!!document.querySelector('.setup-error') && !document.querySelector('.setup-submit').disabled`);
  const openingFailureChecked = await evaluate(`JSON.parse(window.desktopSession.read()).pendingStart.requestId`);
  if (await evaluate(`JSON.parse(window.desktopSession.read()).timeline !== 0`)) throw new Error('Failed opening started the timer');
  await reconnect();
  await waitFor(`!!document.querySelector('.setup-error') && !document.querySelector('.setup-submit').disabled`);
  if (await evaluate(`JSON.parse(window.desktopSession.read()).pendingStart.requestId`) !== openingFailureChecked) throw new Error('Opening retry lost its request ID');
  await evaluate(`document.querySelector('.setup-submit').click()`);
  await waitFor(`!document.querySelector('.setup-dialog') && !!document.querySelector('.send-button') && !document.querySelector('.send-button').disabled`);
  if (await evaluate(`JSON.parse(window.desktopSession.read()).messages.length`) !== 1) throw new Error('Opening was duplicated or stored as a candidate answer');
  const profile = await evaluate(`JSON.parse(window.desktopSession.read()).profile`);
  if (profile?.jobDescription !== '组件平台工程师：Vue、组件设计与自动化测试。') throw new Error('Custom JD did not persist');
  await reconnect();
  await waitFor(`!document.querySelector('.setup-dialog') && !!document.querySelector('.send-button') && !document.querySelector('.send-button').disabled`);

  // Exercise actual Vue input, stream rendering, feedback, evidence and persistence.
  await evaluate(`(() => { const input = document.querySelector('textarea'); input.value = '我负责维护组件库，并通过回归测试验证修复。'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`!!document.querySelector('.send-button') && !document.querySelector('.send-button').disabled`);
  await evaluate(`document.querySelector('.send-button').click()`);
  await waitFor(`document.body.innerText.includes('请举一个组件库维护中的具体问题') && !document.querySelector('.send-button').disabled`);
  await capture(mainWindow, 'desktop');
  await evaluate(`document.querySelector('.interview-header .finish-button').click()`);
  await waitFor(`!!document.querySelector('.feedback-panel') && document.querySelectorAll('.dimension-card').length === 4`);
  await reconnect();
  await waitFor(`!!document.querySelector('.feedback-panel') && document.body.innerText.includes('桌面测试：') && document.body.innerText.includes('已同步保存的面试记录')`);
  const report = await evaluate(`({ dimensions: document.querySelectorAll('.dimension-card').length, evidence: document.body.innerText.includes('我负责维护组件库') })`);
  if (!report.evidence) throw new Error('Feedback evidence was not rendered');
  await capture(mainWindow, 'feedback');
  await evaluate(`document.querySelector('.interview-header .secondary-button').click()`);
  await waitFor(`document.querySelector('#setup-resume')?.value === '' && !!document.querySelector('.setup-dialog[open]')`);
  await evaluate(`(() => { const input = document.querySelector('#setup-resume'); input.value = '新一场简历：参与前端业务开发。'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('.setup-submit').click()`);
  await waitFor(`document.querySelector('#setup-jd')?.value === ''`);
  await evaluate(`document.querySelector('.setup-submit').click()`);
  await waitFor(`!document.querySelector('.setup-dialog') && !!document.querySelector('.send-button') && !document.querySelector('.send-button').disabled`);
  const defaultJDChecked = await evaluate(`JSON.parse(window.desktopSession.read()).profile.jobDescription.includes('前端工程师（应届生）')`);
  if (!defaultJDChecked) throw new Error('Blank JD did not select the default');
  fs.writeFileSync(path.join(dataDir, 'smoke-result.json'), JSON.stringify({ renderer, health, ws, restored, microphone, cameraDenied, encryptedConfig: true, setup: { profile, timerPaused: true, newInterviewReset: true, openingFailureChecked: true, defaultJDChecked }, report, oldOrigin, backendOrigin }));
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const logFile = path.join(dataDir, 'desktop.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.writeFileSync(logFile, '');
    app.setAppUserModelId('com.aiinterview.desktop');
    configureSession();
    configureIpc();
    mainWindow = new BrowserWindow({
      title: 'AIInterview · AI 模拟面试', width: 1320, height: 900, minWidth: 960, minHeight: 680,
      backgroundColor: '#f3f6f8', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: !smoke },
    });
    restrictNavigation(mainWindow, (url) => url === `${frontendOrigin}/`);
    mainWindow.webContents.on('did-navigate', (_event, url) => { loadedFrontendOrigin = new URL(url).origin; });
    mainWindow.once('ready-to-show', () => { if (!smoke) mainWindow.show(); });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '应用', submenu: [
        { label: 'API 设置…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { label: '重新连接后端', click: () => { if (!savingSettings) void reconnect().catch((error) => dialog.showErrorBox('重新连接失败', error.message)); } },
        { label: '打开数据目录', click: () => { void shell.openPath(dataDir); } },
        { type: 'separator' }, { role: 'quit', label: '退出' },
      ] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload', label: '刷新界面' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: '开发者工具' }])] },
    ]));
    await reconnect();
    if (smoke) await runSmokeTest();
    else if (!readConfig().DEEPSEEK_API_KEY || !readConfig().BASE_URL || !readConfig().AI_MODEL) openSettings();
  }).catch((error) => {
    log(error.stack ?? error.message);
    stopBackend();
    if (!smoke) dialog.showErrorBox('AIInterview 启动失败', `${error.message}\n\n日志：${path.join(dataDir, 'desktop.log')}`);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; stopBackend(); void vite?.close(); });
  app.on('will-quit', stopBackend);
}
