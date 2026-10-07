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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-status', {
      type,
      message
    });
  }
}

function credentialsPath() {
  if (app.isPackaged) {
    const portableDir =
      process.env.PORTABLE_EXECUTABLE_DIR;

    if (portableDir) {
      return path.join(
        portableDir,
        'credentials.json'
      );
    }

    return path.join(
      path.dirname(process.execPath),
      'credentials.json'
    );
  }

  return path.join(
    __dirname,
    '..',
    'credentials.json'
  );
}

function tokenPath() {
  return path.join(
    app.getPath('userData'),
    'google-token.json'
  );
}

function loadCredentials() {
  const p = credentialsPath();

  if (!fs.existsSync(p)) {
    throw new Error(
      [
        '找不到 credentials.json',
        '',
        '請將 credentials.json 放在 EXE 同一個資料夾。',
        '',
        '目前預期位置：',
        p,
        '',
        '目前執行的 EXE：',
        process.execPath,
        '',
        'PORTABLE_EXECUTABLE_DIR：',
        process.env.PORTABLE_EXECUTABLE_DIR || '未取得'
      ].join('\n')
    );
  }

  let raw;

  try {
    raw = JSON.parse(
      fs.readFileSync(p, 'utf8')
    );
  } catch (e) {
    throw new Error(
      [
        'credentials.json 無法讀取或不是有效的 JSON。',
        '',
        '檔案位置：',
        p,
        '',
        '詳細原因：',
        e.message
      ].join('\n')
    );
  }

  const credentials =
    raw.installed ||
    raw.web ||
    raw;

  if (
    !credentials.client_id ||
    !credentials.client_secret
  ) {
    throw new Error(
      [
        'credentials.json 格式不正確。',
        '',
        '請確認你下載的是 Google Cloud OAuth Desktop Client JSON。',
        '',
        '檔案位置：',
        p
      ].join('\n')
    );
  }

  return credentials;
}

function createOAuthClient(port) {
  const credentials =
    loadCredentials();

  const redirect =
    `http://127.0.0.1:${port}/oauth2callback`;

  return new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    redirect
  );
}

/**
 * 啟動 OAuth callback server，
 * 取得動態 Port，
 * 等待 Google 回傳授權碼。
 */
function startOAuthServer() {
  return new Promise((resolve, reject) => {
    const server =
      http.createServer();

    server.once(
      'error',
      reject
    );

    server.on(
      'request',
      (req, res) => {
        const parsed =
          url.parse(
            req.url,
            true
          );

        if (
          parsed.pathname !==
          '/oauth2callback'
        ) {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }

        if (
          parsed.query.error
        ) {
          res.end(
            '登入已取消，可以關閉此視窗。'
          );

          server.close();

          reject(
            new Error(
              parsed.query.error
            )
          );

          return;
        }

        const code =
          parsed.query.code;

        if (!code) {
          res.statusCode = 400;

          res.end(
            '沒有取得 Google OAuth 授權碼。'
          );

          server.close();

          reject(
            new Error(
              'Google OAuth callback 沒有回傳 code。'
            )
          );

          return;
        }

        res.end(`
          <html>
            <body style="font-family:sans-serif;padding:40px">
              Google 登入完成，可以關閉此視窗。
            </body>
          </html>
        `);

        server.close(() => {
          resolve({
            code,
            port
          });
        });
      }
    );

    server.listen(
      0,
      '127.0.0.1',
      () => {
        const address =
          server.address();

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

        port = address.port;
      }
    );
  });
}

async function googleLogin() {
  loadCredentials();

  const oauthServerPromise =
    startOAuthServer();

  /*
   * startOAuthServer 會等到 Google callback
   * 才 resolve，所以需要先從 Server 取得 Port。
   *
   * 這裡重新採用明確的 callback server 建立方式。
   */
  const server =
    http.createServer();

  const port =
    await new Promise(
      (resolve, reject) => {
        server.once(
          'error',
          reject
        );

        server.listen(
          0,
          '127.0.0.1',
          () => {
            const address =
              server.address();

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

            resolve(
              address.port
            );
          }
        );
      }
    );

  oauth2Client =
    createOAuthClient(port);

  const authUrl =
    oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES
    });

  sendStatus(
    'info',
    '正在開啟 Google 登入頁面…'
  );

  await shell.openExternal(
    authUrl
  );

  const code =
    await new Promise(
      (resolve, reject) => {
        server.on(
          'request',
          (req, res) => {
            const parsed =
              url.parse(
                req.url,
                true
              );

            if (
              parsed.pathname !==
              '/oauth2callback'
            ) {
              res.statusCode = 404;
              res.end('Not Found');
              return;
            }

            if (
              parsed.query.error
            ) {
              res.end(
                '登入已取消，可以關閉此視窗。'
              );

              server.close();

              reject(
                new Error(
                  parsed.query.error
                )
              );

              return;
            }

            const code =
              parsed.query.code;

            if (!code) {
              res.statusCode = 400;

              res.end(
                '沒有取得 Google OAuth 授權碼。'
              );

              server.close();

              reject(
                new Error(
                  'Google OAuth callback 沒有回傳 code。'
                )
              );

              return;
            }

            res.end(`
              <html>
                <body style="font-family:sans-serif;padding:40px">
                  Google 登入完成，可以關閉此視窗。
                </body>
              </html>
            `);

            server.close();

            resolve(code);
          }
        );
      }
    );

  const { tokens } =
    await oauth2Client.getToken(
      code
    );

  oauth2Client.setCredentials(
    tokens
  );

  fs.mkdirSync(
    path.dirname(tokenPath()),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    tokenPath(),
    JSON.stringify(
      tokens,
      null,
      2
    ),
    'utf8'
  );

  sendStatus(
    'logged-in',
    'Google 登入成功'
  );

  return {
    ok: true
  };
}

function loadSavedAuth() {
  if (
    !fs.existsSync(
      tokenPath()
    )
  ) {
    return false;
  }

  if (!oauth2Client) {
    oauth2Client =
      createOAuthClient(0);
  }

  const tokens =
    JSON.parse(
      fs.readFileSync(
        tokenPath(),
        'utf8'
      )
    );

  oauth2Client.setCredentials(
    tokens
  );

  return true;
}

async function getAuth() {
  if (!oauth2Client) {
    if (!loadSavedAuth()) {
      throw new Error(
        '尚未登入 Google 帳號。'
      );
    }
  }

  return oauth2Client;
}

async function listGoogleForms() {
  const auth =
    await getAuth();

  const drive =
    google.drive({
      version: 'v3',
      auth
    });

  const out = [];

  let pageToken;

  do {
    const r =
      await drive.files.list({
        q: "mimeType='application/vnd.google-apps.form' and trashed=false",
        fields:
          'nextPageToken, files(id,name,modifiedTime,webViewLink)',
        orderBy:
          'modifiedTime desc',
        pageSize: 100,
        pageToken
      });

    out.push(
      ...(r.data.files || [])
    );

    pageToken =
      r.data.nextPageToken;

  } while (pageToken);

  return out;
}

async function readForm(formId) {
  const auth =
    await getAuth();

  const forms =
    google.forms({
      version: 'v1',
      auth
    });

  const r =
    await forms.forms.get({
      formId
    });

  return r.data;
}

async function readResponses(formId) {
  const auth =
    await getAuth();

  const forms =
    google.forms({
      version: 'v1',
      auth
    });

  const all = [];

  let pageToken;

  do {
    const r =
      await forms.forms.responses.list({
        formId,
        pageSize: 500,
        pageToken
      });

    all.push(
      ...(r.data.responses || [])
    );

    pageToken =
      r.data.nextPageToken;

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
      backgroundColor: '#0d1117',

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
  googleLogin
);

ipcMain.handle(
  'list-forms',
  listGoogleForms
);

ipcMain.handle(
  'read-form',
  (_e, id) =>
    readForm(id)
);

ipcMain.handle(
  'read-responses',
  (_e, id) =>
    readResponses(id)
);

ipcMain.handle(
  'logout',
  () => {
    oauth2Client = null;

    try {
      fs.unlinkSync(
        tokenPath()
      );
    } catch (_) {}

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
  () =>
    fs.existsSync(
      tokenPath()
    )
);

ipcMain.handle(
  'open-v138-reference',
  () =>
    shell.openPath(
      path.join(
        __dirname,
        'v138-reference.html'
      )
    )
);

app.whenReady()
  .then(createWindow);

app.on(
  'window-all-closed',
  () => {
    if (
      process.platform !==
      'darwin'
    ) {
      app.quit();
    }
  }
);
