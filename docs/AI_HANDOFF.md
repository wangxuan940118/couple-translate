# Our Little World — GPT／Codex 共用交接

更新日期：2026-11-10。

## 本次優先事項

使用者要求先修復關閉網站後聊天紀錄消失：以 Supabase PostgreSQL 保存訊息、Supabase Auth 驗證兩位使用者、恢復安全工作階段、分頁歷史、離線訊息與重試去重。愛心只代表畫面選擇，不是驗證。

相關程式：`lib/private-chat.js`、`supabase/private-chat.sql`、`server.js`、`public/auth.js`、`public/app.js`。設定與驗收見 [PERSISTENT_CHAT_SETUP.md](PERSISTENT_CHAT_SETUP.md) 及 [TESTING.md](TESTING.md)。不要再把記憶體、瀏覽器儲存或 `ROOM_DATA_PATH` 檔案作為滿足此需求的方案。

## 環境及提交

- Repository：<https://github.com/wangxuan940118/couple-translate>
- 讀取過的最新 main：`9e37543ebf6a564bd34b671830f98d82c4ec8afe`；修改或合併前必須重新確認，保留其他開發者的變更。
- 單獨愛心 UI 提交：`b09e0e8a93e084d51dc17a5247dd2b233060df63`，PR：<https://github.com/wangxuan940118/couple-translate/pull/2>。只改可見身分文案及樣式，不改聊天／翻譯／通話 JS。
- 測試入口：<https://couple-world-lab.fullbluff.chatgpt.site>；project `appgprj_6af11b4502108191b06d344400cd1cb9`。
- 現有 Render：<https://couple-translate.onrender.com/>。
- LAB 是 Worker／D1；Render 版本是 Node.js／WebSocket。不可把兩套不同協定未經整合直接混用。
- 不更新舊 `couple-world-test` 站。NAS 未知、未連線、未部署。使用者現已授權部署整理好的版本，但主機位址與存取尚未提供。

## 不可混淆的狀態

程式已提交、部署成功、資料庫實際持久化驗收成功、雙人手機通話實測成功，必須分開回報。本次工作開始時，使用者尚未建立或確認可用 Supabase／PostgreSQL 專案，沒有可宣稱已連通的正式資料庫。自動化 mock 測試不能證明真實雲端資料或 iPhone 通話已通過。

保留十種語言、文字翻譯、語音／視訊、字幕與現有互動。持久化失敗不得阻塞 WebRTC；不播放 AI 翻譯語音。不宣稱端對端加密。所有 service_role、翻譯及 TURN 秘密只放伺服器環境。

## 與另一個 GPT 協作

這份檔案是可由使用者分享的交接來源。Codex 無法自動讀取另一個私人 GPT 對話，也沒有把所有工具指令即時同步到其他對話的功能；不要聲稱已聯動或取得未提供的聊天紀錄。若另有需求，使用者可提供那段文字或分享連結，再將有效需求更新至此檔案。

## 本批前端整合狀態

已加入已驗證登入後恢復房間、PostgreSQL 歷史分頁、伺服器 ACK 前等待狀態、具固定 ID 的待傳佇列、斷線重連、同帳號分頁互斥、通話不中斷的 WS 登入續期、雙方時區顯示。語言與愛心分開記憶；歷史只翻譯對方訊息，預設限制自動翻譯最近十則並以兩個工作處理。主畫面圖片使用使用者參考生成之 JPEG。

這些是程式與 DOM／協定測試結果，尚未證明真實 Supabase、重部署或兩支手機通過。使用者已建立 Supabase 專案，且截圖顯示初始化 SQL 已成功執行；兩個帳號設定進行中，目前尚無伺服器環境金鑰或 Render／NAS 管理存取。不能把既有 LAB 外觀更新說成 PostgreSQL 已部署。

## 已核對的提交與上線狀態

- 完整私人聊天程式：`7e9439b0fd3f78621d2f1d77c84772c2e2db85e5`，PR #4 尚為 draft、未合併。55 項測試通過，GitHub Actions run `42817611450` 為 success。真實讀寫／關閉重開／重部署持久性仍待驗收。
- LAB 封面與雙愛心第 6 版已部署成功，來源 `b49a0e3f0b0f7168d6613ffc51e8d1a62666ecbc`，deployment `appgdep_6af310ba32808191b350645a73bf5635`。這是既有 Worker 測試站的外觀更新，不是 PostgreSQL 功能上線。
- NAS 部署檔案已備妥，見 `docs/NAS_DEPLOY.md`。本機 Docker socket 存取被拒，附加權限檢查另遇 sandbox 掛載錯誤；映像建置與 NAS 執行尚未驗證。使用者表示不知道 NAS 管理位址，正在釐清其所指是雲端正式上線或實體 NAS。
