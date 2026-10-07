# 表單抽選 App

Google Forms API 測試版，UI 以 V1.3.8 為設計參考。

## 本機使用

1. 將 Google Cloud Desktop OAuth Client JSON 重新命名為 `credentials.json`。
2. 開發模式下放在專案根目錄。
3. `npm install`
4. `npm start`

## Windows EXE

GitHub Actions 會在 Windows runner 上建立 Portable EXE，不需要在使用者電腦安裝 Node.js/npm。

執行 EXE 前，請把自己的 `credentials.json` 放在 EXE 同一層。不要將真正的 `credentials.json` 上傳到 GitHub。

## 目前測試功能

- Google OAuth 登入
- 讀取目前 Google 帳號可存取的 Google Forms
- 讀取表單內容
- 讀取表單回覆（API scope 已加入測試）
- V1.3.8 原版檔案僅作為 UI/功能參考，未修改原始 Library 檔案
