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

    if (portableDir) {
      return path.join(portableDir, 'credentials.json');
    }

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
    mainWindow.webContents.send('app-status', {
      type,
      message,
      data
    });
  }
}

function loadCredentials() {
  const p = credentialsPath();

  if (!fs.existsSync(p)) {
    throw new Error(
      `找不到 credentials.json。\n` +
      `請將 Google Cloud Desktop OAuth JSON 放在 EXE 同一層。\n` +
      `目前尋找位置：${p}`
    );
  }

  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cfg = raw.installed || raw.web || raw;

  if (!cfg || !cfg.client_id || !cfg.client_secret) {
    throw new Error(
      'credentials.json 不是有效的 Google OAuth Desktop Client 設定檔。'
    );
  }

  return cfg;
}

function createOAuthClient(port = 0) {
  const cfg = loadCredentials();

  const redirectUri =
    `http://127.0.0.1:${port}/oauth2callback`;

  return new google.auth.OAuth2(
    cfg.client_id,
    cfg.client_secret,
    redirectUri
  );
}

function saveToken(tokens) {
  fs.mkdirSync(path.dirname(tokenPath()), {
    recursive: true
  });

  fs.writeFileSync(
    tokenPath(),
    JSON.stringify(tokens, null, 2),
    'utf8'
  );
}

function loadToken() {
  if (!fs.existsSync(tokenPath())) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(tokenPath(), 'utf8')
    );
  } catch (_) {
    return null;
  }
}

function saveAccount(account) {
  fs.mkdirSync(path.dirname(accountPath()), {
    recursive: true
  });

  fs.writeFileSync(
    accountPath(),
    JSON.stringify(account || {}, null, 2),
    'utf8'
  );
}

function loadAccount() {
  if (!fs.existsSync(accountPath())) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(accountPath(), 'utf8')
    );
  } catch (_) {
    return null;
  }
}

function attachTokenPersistence(client) {
  client.on('tokens', (tokens) => {
    const old = loadToken() || {};

    const merged = {
      ...old,
      ...tokens
    };

    saveToken(merged);
  });
}

function createAuthorizedClient(tokens) {
  const cfg = loadCredentials();

  const client = new google.auth.OAuth2(
    cfg.client_id,
    cfg.client_secret
  );

  client.setCredentials(tokens);

  attachTokenPersistence(client);

  return client;
}

function randomState() {
  return crypto
    .randomBytes(24)
    .toString('hex');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);

    server.listen(
      0,
      '127.0.0.1',
      () => {
        const address = server.address();

        if (
          !address ||
          typeof address === 'string'
        ) {
          server.close();

          reject(
            new Error(
              '無法取得 OAuth callback Server Port。'
            )
          );

          return;
        }

        const port = address.port;

        server.close(() => {
          resolve(port);
        });
      }
    );
  });
}

/*
 * V1.0.2 修正版：
 *
 * 不再呼叫 Google UserInfo API。
 *
 * 目前 OAuth scope 只需要：
 * - Drive metadata
 * - Forms body
 * - Forms responses
 *
 * 因此帳號資訊改為本機保存的狀態。
 */
function getSavedAccount() {
  return loadAccount() || {
    email: '',
    name: '',
    picture: '',
    updatedAt: new Date().toISOString()
  };
}

/*
 * 強制使用 Refresh Token 更新 Access Token。
 *
 * 這可以確認目前保存的 refresh_token 是否仍然有效，
 * 同時讓 google-auth-library 保存新的 token。
 */
async function refreshAuthorizedClient(client) {
  const current = loadToken() || {};

  if (!current.refresh_token) {
    throw new Error(
      '找不到 Google Refresh Token。'
    );
  }

  const { credentials } =
    await client.refreshAccessToken();

  const merged = {
    ...current,
    ...credentials
  };

  /*
   * Google 某些情況不會再次回傳 refresh_token，
   * 因此一定保留原本的 refresh_token。
   */
  if (!merged.refresh_token) {
    merged.refresh_token = current.refresh_token;
  }

  client.setCredentials(merged);

  saveToken(merged);

  return merged;
}

function isInvalidGrantError(error) {
  const responseData =
    error?.response?.data;

  return (
    responseData?.error === 'invalid_grant' ||
    String(error?.message || '')
      .toLowerCase()
      .includes('invalid_grant')
  );
}

async function startGoogleLogin() {
  if (oauthServer) {
    try {
      oauthServer.close();
    } catch (_) {}

    oauthServer = null;
  }

  const port = await findFreePort();

  oauthState = randomState();

  oauth2Client = createOAuthClient(port);

  /*
   * 只掛一次 Token persistence。
   */
  attachTokenPersistence(oauth2Client);

  const codePromise = new Promise(
    (resolve, reject) => {
      oauthServer = http.createServer(
        async (req, res) => {
          const parsed =
            url.parse(req.url, true);

          if (
            parsed.pathname !==
            '/oauth2callback'
          ) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }

          try {
            if (
              parsed.query.state !==
              oauthState
            ) {
              throw new Error(
                'Google OAuth state 驗證失敗，登入流程已中止。'
              );
            }

            if (parsed.query.error) {
              throw new Error(
                `Google 授權已取消：${parsed.query.error}`
              );
            }

            if (!parsed.query.code) {
              throw new Error(
                'Google 沒有回傳授權碼。'
              );
            }

            res.writeHead(200, {
              'Content-Type':
                'text/html; charset=utf-8'
            });

            res.end(`
<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>登入成功</title>
</head>
<body style="
  font-family:system-ui;
  padding:40px;
  background:#08111d;
  color:#eef;
">
  Google 登入完成，可以回到「表單抽選 App」。
</body>
</html>
`);

            resolve(
              String(parsed.query.code)
            );
          } catch (err) {
            try {
              res.writeHead(400, {
                'Content-Type':
                  'text/html; charset=utf-8'
              });

              const safeMessage =
                String(
                  err.message || err
                ).replace(
                  /[&<>]/g,
                  ''
                );

              res.end(`
<h2>Google 登入失敗</h2>
<p>${safeMessage}</p>
`);
            } catch (_) {}

            reject(err);
          }
        }
      );
    }
  );

  await new Promise(
    (resolve, reject) => {
      oauthServer.once(
        'error',
        reject
      );

      oauthServer.listen(
        port,
        '127.0.0.1',
        resolve
      );
    }
  );

  try {
    const existing = loadToken();

    const authUrl =
      oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        include_granted_scopes: true,
        state: oauthState,

        /*
         * 第一次登入需要 consent。
         * 已經有 refresh_token 時讓使用者選帳號。
         */
        prompt:
          existing?.refresh_token
            ? 'select_account'
            : 'consent'
      });

    sendStatus(
      'info',
      existing?.refresh_token
        ? '正在開啟 Google 帳號選擇頁面…'
        : '正在開啟 Google 登入頁面…'
    );

    await shell.openExternal(
      authUrl
    );

    const code =
      await codePromise;

    const { tokens } =
      await oauth2Client.getToken(
        code
      );

    /*
     * Google 在重新授權時，
     * 不一定會再次提供 refresh_token。
     */
    const mergedTokens = {
      ...(existing || {}),
      ...tokens
    };

    if (!mergedTokens.refresh_token) {
      throw new Error(
        'Google 沒有提供 refresh token，無法建立持續登入狀態。請重新登入並授權。'
      );
    }

    oauth2Client.setCredentials(
      mergedTokens
    );

    saveToken(
      mergedTokens
    );

    /*
     * 不再呼叫 UserInfo API。
     *
     * 第一版只保存登入狀態，
     * 不要求額外 email/profile scope。
     */
    const oldAccount =
      loadAccount();

    const account = {
      ...(oldAccount || {}),
      email:
        oldAccount?.email || '',
      name:
        oldAccount?.name || '',
      picture:
        oldAccount?.picture || '',
      updatedAt:
        new Date().toISOString()
    };

    saveAccount(account);

    sendStatus(
      'logged-in',
      '✓ Google 登入成功',
      account
    );

    return {
      ok: true,
      account
    };
  } catch (error) {
    sendStatus(
      'error',
      error.message ||
        'Google 登入失敗。'
    );

    throw error;
  } finally {
    oauthState = null;

    if (oauthServer) {
      try {
        oauthServer.close();
      } catch (_) {}

      oauthServer = null;
    }
  }
}

async function restoreSavedAuth() {
  const tokens = loadToken();

  if (!tokens?.refresh_token) {
    return {
      loggedIn: false
    };
  }

  try {
    oauth2Client =
      createAuthorizedClient(
        tokens
      );

    /*
     * 不再呼叫 UserInfo API。
     *
     * 直接使用 refresh_token 取得新的
     * access_token，確認持續登入狀態有效。
     */
    await refreshAuthorizedClient(
      oauth2Client
    );

    const account =
      getSavedAccount();

    sendStatus(
      'restored',
      '✓ 已恢復 Google 登入狀態',
      account
    );

    return {
      loggedIn: true,
      account
    };
  } catch (error) {
    /*
     * 只有 Google 明確回覆 invalid_grant
     * 才視為 Refresh Token 已失效。
     *
     * 網路錯誤、暫時性 API 錯誤不要刪除 Token。
     */
    if (isInvalidGrantError(error)) {
      try {
        fs.rmSync(
          tokenPath(),
          { force: true }
        );
      } catch (_) {}

      try {
        fs.rmSync(
          accountPath(),
          { force: true }
        );
      } catch (_) {}

      oauth2Client = null;

      sendStatus(
        'error',
        'Google 登入狀態已失效，請重新登入。'
      );

      return {
        loggedIn: false,
        error:
          error.message ||
          String(error)
      };
    }

    /*
     * 非 invalid_grant：
     * 保留 Token，避免暫時網路問題造成登出。
     */
    const account =
      getSavedAccount();

    sendStatus(
      'error',
      '無法暫時驗證 Google 登入狀態，請確認網路連線後再試。',
      account
    );

    return {
      loggedIn: true,
      account,
      temporaryError:
        error.message ||
        String(error)
    };
  }
}

function getAuthorizedClient() {
  if (oauth2Client) {
    return oauth2Client;
  }

  const tokens =
    loadToken();

  if (!tokens?.refresh_token) {
    throw new Error(
      '尚未登入 Google 帳號。'
    );
  }

  oauth2Client =
    createAuthorizedClient(
      tokens
    );

  return oauth2Client;
}

async function listGoogleForms() {
  const auth =
    getAuthorizedClient();

  const drive =
    google.drive({
      version: 'v3',
      auth
    });

  const forms = [];

  let pageToken;

  do {
    const res =
      await drive.files.list({
        q:
          "mimeType='application/vnd.google-apps.form' and trashed=false",
        fields:
          'nextPageToken, files(id,name,modifiedTime,webViewLink)',
        orderBy:
          'modifiedTime desc',
        pageSize: 100,
        pageToken
      });

    forms.push(
      ...(res.data.files || [])
    );

    pageToken =
      res.data.nextPageToken;
  } while (pageToken);

  return forms;
}

async function readForm(formId) {
  const auth =
    getAuthorizedClient();

  const formsApi =
    google.forms({
      version: 'v1',
      auth
    });

  const res =
    await formsApi.forms.get({
      formId
    });

  return res.data;
}

async function readResponses(formId) {
  const auth =
    getAuthorizedClient();

  const formsApi =
    google.forms({
      version: 'v1',
      auth
    });

  const all = [];

  let pageToken;

  do {
    const res =
      await formsApi.forms.responses.list({
        formId,
        pageSize: 500,
        pageToken
      });

    all.push(
      ...(res.data.responses || [])
    );

    pageToken =
      res.data.nextPageToken;
  } while (pageToken);

  return all;
}

function createWindow() {
  mainWindow =
    new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 680,
      backgroundColor: '#08111d',

      webPreferences: {
        preload:
          path.join(
            __dirname,
            'preload.js'
          ),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

  mainWindow.loadFile(
    path.join(
      __dirname,
      'index.html'
    )
  );
}

ipcMain.handle(
  'google-login',
  startGoogleLogin
);

ipcMain.handle(
  'restore-auth',
  restoreSavedAuth
);

ipcMain.handle(
  'list-forms',
  async () => ({
    ok: true,
    forms:
      await listGoogleForms()
  })
);

ipcMain.handle(
  'read-form',
  async (
    _event,
    id
  ) => ({
    ok: true,
    form:
      await readForm(id)
  })
);

ipcMain.handle(
  'read-responses',
  async (
    _event,
    id
  ) => ({
    ok: true,
    responses:
      await readResponses(id)
  })
);

ipcMain.handle(
  'get-account',
  async () => ({
    ok: true,
    account:
      loadAccount()
  })
);

ipcMain.handle(
  'logout',
  async () => {
    try {
      fs.rmSync(
        tokenPath(),
        { force: true }
      );
    } catch (_) {}

    try {
      fs.rmSync(
        accountPath(),
        { force: true }
      );
    } catch (_) {}

    oauth2Client = null;

    sendStatus(
      'logged-out',
      '已登出 Google'
    );

    return {
      ok: true
    };
  }
);

ipcMain.handle(
  'has-token',
  async () => ({
    ok: true,
    loggedIn:
      !!loadToken()?.refresh_token,
    account:
      loadAccount()
  })
);

app.whenReady().then(
  async () => {
    createWindow();

    app.on(
      'activate',
      () => {
        if (
          BrowserWindow.getAllWindows()
            .length === 0
        ) {
          createWindow();
        }
      }
    );

    await restoreSavedAuth();
  }
);

app.on(
  'window-all-closed',
  () => {
    if (oauthServer) {
      try {
        oauthServer.close();
      } catch (_) {}
    }

    if (
      process.platform !==
      'darwin'
    ) {
      app.quit();
    }
  }
);
 
