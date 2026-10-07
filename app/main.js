const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const net = require('net');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/forms.body.readonly',
  'https://www.googleapis.com/auth/forms.responses.readonly'
];

let mainWindow;
let oauthServer = null;
let oauthState = null;
let oauth2Client = null;

function credentialsPath() {
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) return path.join(portableDir, 'credentials.json');
    return path.join(path.dirname(process.execPath), 'credentials.json');
  }
  return path.join(__dirname, '..', 'credentials.json');
}

function tokenPath() {
  return path.join(app.getPath('userData'), 'google-token.json');
}

function accountPath() {
  return path.join(app.getPath('userData'), 'google-account.json');
}

function sendStatus(type, message, data = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-status', { type, message, data });
  }
}

function loadCredentials() {
  const p = credentialsPath();
  if (!fs.existsSync(p)) {
    throw new Error(`找不到 credentials.json。\n請將 Google Cloud Desktop OAuth JSON 放在 EXE 同一層。\n目前尋找位置：${p}`);
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cfg = raw.installed || raw.web || raw;
  if (!cfg || !cfg.client_id || !cfg.client_secret) {
    throw new Error('credentials.json 不是有效的 Google OAuth Desktop Client 設定檔。');
  }
  return cfg;
}

function createOAuthClient(port = 0) {
  const cfg = loadCredentials();
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirectUri);
}

function saveToken(tokens) {
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2), 'utf8');
}

function loadToken() {
  if (!fs.existsSync(tokenPath())) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveAccount(account) {
  fs.mkdirSync(path.dirname(accountPath()), { recursive: true });
  fs.writeFileSync(accountPath(), JSON.stringify(account || {}, null, 2), 'utf8');
}

function loadAccount() {
  if (!fs.existsSync(accountPath())) return null;
  try {
    return JSON.parse(fs.readFileSync(accountPath(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function attachTokenPersistence(client) {
  client.on('tokens', (tokens) => {
    const old = loadToken() || {};
    saveToken({ ...old, ...tokens });
  });
}

function createAuthorizedClient(tokens) {
  const cfg = loadCredentials();
  const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
  client.setCredentials(tokens);
  attachTokenPersistence(client);
  return client;
}

function randomState() {
  return crypto.randomBytes(24).toString('hex');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('無法取得 OAuth callback Server Port。'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchGoogleAccount(client) {
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const me = await oauth2.userinfo.get();
  const user = me.data || {};
  const account = {
    email: user.email || '',
    name: user.name || '',
    picture: user.picture || '',
    updatedAt: new Date().toISOString()
  };
  saveAccount(account);
  return account;
}

async function startGoogleLogin() {
  if (oauthServer) {
    try { oauthServer.close(); } catch (_) {}
    oauthServer = null;
  }

  const port = await findFreePort();
  oauthState = randomState();
  oauth2Client = createOAuthClient(port);
  attachTokenPersistence(oauth2Client);

  const codePromise = new Promise((resolve, reject) => {
    oauthServer = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/oauth2callback') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      try {
        if (parsed.query.state !== oauthState) {
          throw new Error('Google OAuth state 驗證失敗，登入流程已中止。');
        }
        if (parsed.query.error) {
          throw new Error(`Google 授權已取消：${parsed.query.error}`);
        }
        if (!parsed.query.code) {
          throw new Error('Google 沒有回傳授權碼。');
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>登入成功</title><body style="font-family:system-ui;padding:40px;background:#08111d;color:#eef">Google 登入完成，可以回到「表單抽選 App」。</body></html>');
        resolve(String(parsed.query.code));
      } catch (err) {
        try {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h2>Google 登入失敗</h2><p>${String(err.message || err).replace(/[&<>]/g, '')}</p>`);
        } catch (_) {}
        reject(err);
      }
    });
  });

  await new Promise((resolve, reject) => {
    oauthServer.once('error', reject);
    oauthServer.listen(port, '127.0.0.1', resolve);
  });

  try {
    const existing = loadToken();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      include_granted_scopes: true,
      state: oauthState,
      prompt: existing?.refresh_token ? 'select_account' : 'consent'
    });

    sendStatus('info', existing?.refresh_token ? '正在開啟 Google 帳號選擇頁面…' : '正在開啟 Google 登入頁面…');
    await shell.openExternal(authUrl);

    const code = await codePromise;
    const { tokens } = await oauth2Client.getToken(code);

    // Google 在部分重新授權情況下可能不再次回傳 refresh_token；保留舊 token。
    const mergedTokens = { ...(existing || {}), ...tokens };
    if (!mergedTokens.refresh_token) {
      throw new Error('Google 沒有提供 refresh token，無法建立持續登入狀態。請重新登入並授權。');
    }

    oauth2Client.setCredentials(mergedTokens);
    saveToken(mergedTokens);
    const account = await fetchGoogleAccount(oauth2Client);

    sendStatus('logged-in', `✓ 已登入 ${account.email || 'Google 帳號'}`, account);
    return { ok: true, account };
  } catch (error) {
    sendStatus('error', error.message || 'Google 登入失敗。');
    throw error;
  } finally {
    oauthState = null;
    if (oauthServer) {
      try { oauthServer.close(); } catch (_) {}
      oauthServer = null;
    }
  }
}

async function restoreSavedAuth() {
  const tokens = loadToken();
  if (!tokens?.refresh_token) return { loggedIn: false };

  try {
    oauth2Client = createAuthorizedClient(tokens);
    // 主動取得帳號資料，同時驗證 token 是否仍可用；若 access token 過期，google-auth-library 會用 refresh token 更新。
    const account = await fetchGoogleAccount(oauth2Client);
    sendStatus('restored', `✓ 已恢復登入：${account.email || 'Google 帳號'}`, account);
    return { loggedIn: true, account };
  } catch (error) {
    // Token 失效時清除本機登入狀態，避免 App 卡在假登入。
    try { fs.rmSync(tokenPath(), { force: true }); } catch (_) {}
    try { fs.rmSync(accountPath(), { force: true }); } catch (_) {}
    oauth2Client = null;
    sendStatus('error', `登入狀態已失效，請重新登入 Google。`);
    return { loggedIn: false, error: error.message || String(error) };
  }
}

function getAuthorizedClient() {
  if (oauth2Client) return oauth2Client;
  const tokens = loadToken();
  if (!tokens?.refresh_token) throw new Error('尚未登入 Google 帳號。');
  oauth2Client = createAuthorizedClient(tokens);
  return oauth2Client;
}

async function listGoogleForms() {
  const auth = getAuthorizedClient();
  const drive = google.drive({ version: 'v3', auth });
  const forms = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.form' and trashed=false",
      fields: 'nextPageToken, files(id,name,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      pageToken
    });
    forms.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return forms;
}

async function readForm(formId) {
  const auth = getAuthorizedClient();
  const formsApi = google.forms({ version: 'v1', auth });
  const res = await formsApi.forms.get({ formId });
  return res.data;
}

async function readResponses(formId) {
  const auth = getAuthorizedClient();
  const formsApi = google.forms({ version: 'v1', auth });
  const all = [];
  let pageToken;
  do {
    const res = await formsApi.forms.responses.list({ formId, pageSize: 500, pageToken });
    all.push(...(res.data.responses || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: '#08111d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('google-login', startGoogleLogin);
ipcMain.handle('restore-auth', restoreSavedAuth);
ipcMain.handle('list-forms', async () => ({ ok: true, forms: await listGoogleForms() }));
ipcMain.handle('read-form', async (_event, id) => ({ ok: true, form: await readForm(id) }));
ipcMain.handle('read-responses', async (_event, id) => ({ ok: true, responses: await readResponses(id) }));
ipcMain.handle('get-account', async () => ({ ok: true, account: loadAccount() }));
ipcMain.handle('logout', async () => {
  try { fs.rmSync(tokenPath(), { force: true }); } catch (_) {}
  try { fs.rmSync(accountPath(), { force: true }); } catch (_) {}
  oauth2Client = null;
  sendStatus('logged-out', '已登出 Google');
  return { ok: true };
});
ipcMain.handle('has-token', async () => ({ ok: true, loggedIn: !!loadToken()?.refresh_token, account: loadAccount() }));

app.whenReady().then(async () => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  await restoreSavedAuth();
});

app.on('window-all-closed', () => {
  if (oauthServer) {
    try { oauthServer.close(); } catch (_) {}
  }
  if (process.platform !== 'darwin') app.quit();
});
