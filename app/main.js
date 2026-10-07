const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');
const { google } = require('googleapis');

let mainWindow;
let oauth2Client;

const SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/forms.body.readonly',
  'https://www.googleapis.com/auth/forms.responses.readonly'
];

function sendStatus(type, message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-status', { type, message });
}

function credentialsPath() {
  if (app.isPackaged) return path.join(path.dirname(process.execPath), 'credentials.json');
  return path.join(__dirname, '..', 'credentials.json');
}

function tokenPath() {
  return path.join(app.getPath('userData'), 'google-token.json');
}

function loadCredentials() {
  const p = credentialsPath();
  if (!fs.existsSync(p)) throw new Error(`找不到 credentials.json\n請將 Google OAuth Desktop Client JSON 重新命名為 credentials.json，放在 EXE 同一層。\n目前尋找位置：${p}`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return raw.installed || raw.web || raw;
}

function createOAuthClient(port) {
  const c = loadCredentials();
  const redirect = `http://127.0.0.1:${port}/oauth2callback`;
  return new google.auth.OAuth2(c.client_id, c.client_secret, redirect);
}

async function waitForOAuthCode(authUrl, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/oauth2callback') return;
      if (parsed.query.error) {
        res.end('登入已取消，可以關閉此頁。');
        server.close();
        reject(new Error(parsed.query.error));
        return;
      }
      const code = parsed.query.code;
      res.end('<html><body style="font-family:sans-serif;padding:40px">Google 登入完成，可以關閉此視窗。</body></html>');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', async () => {
      try {
        await shell.openExternal(authUrl);
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

async function googleLogin() {
  loadCredentials();
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.close(resolve); });
  });
  const port = server.address().port;
  oauth2Client = createOAuthClient(port);
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  sendStatus('info', '正在開啟 Google 登入頁面…');
  const code = await waitForOAuthCode(authUrl, port);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2), 'utf8');
  sendStatus('logged-in', 'Google 登入成功');
  return { ok: true };
}

function loadSavedAuth() {
  if (!fs.existsSync(tokenPath())) return false;
  if (!oauth2Client) oauth2Client = createOAuthClient(0);
  const tokens = JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
  oauth2Client.setCredentials(tokens);
  return true;
}

async function getAuth() {
  if (!oauth2Client) {
    if (!loadSavedAuth()) throw new Error('尚未登入 Google 帳號。');
  }
  return oauth2Client;
}

async function listGoogleForms() {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const out = [];
  let pageToken;
  do {
    const r = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.form' and trashed=false",
      fields: 'nextPageToken, files(id,name,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      pageToken
    });
    out.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function readForm(formId) {
  const auth = await getAuth();
  const forms = google.forms({ version: 'v1', auth });
  const r = await forms.forms.get({ formId });
  return r.data;
}

async function readResponses(formId) {
  const auth = await getAuth();
  const forms = google.forms({ version: 'v1', auth });
  const all = [];
  let pageToken;
  do {
    const r = await forms.forms.responses.list({ formId, pageSize: 500, pageToken });
    all.push(...(r.data.responses || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return all;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('google-login', googleLogin);
ipcMain.handle('list-forms', listGoogleForms);
ipcMain.handle('read-form', (_e, id) => readForm(id));
ipcMain.handle('read-responses', (_e, id) => readResponses(id));
ipcMain.handle('logout', () => {
  oauth2Client = null;
  try { fs.unlinkSync(tokenPath()); } catch (_) {}
  sendStatus('logged-out', '已登出 Google');
  return { ok: true };
});
ipcMain.handle('has-token', () => fs.existsSync(tokenPath()));
ipcMain.handle('open-v138-reference', () => shell.openPath(path.join(__dirname, 'v138-reference.html')));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
