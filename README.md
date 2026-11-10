# Our Little World

雙人跨語言私人聊天室，保留文字翻譯、語音／視訊通話、雙語字幕及白／黑愛心選擇。此次聊天歷史使用 **Supabase PostgreSQL**，登入使用 **Supabase Auth**；伺服器只允許設定中的兩個已驗證帳號讀寫房間。

- 開發測試入口：https://couple-world-lab.fullbluff.chatgpt.site
- 現有 Render 網站：https://couple-translate.onrender.com/
- 資料庫與帳號設定：[docs/PERSISTENT_CHAT_SETUP.md](docs/PERSISTENT_CHAT_SETUP.md)
- 測試與驗收：[docs/TESTING.md](docs/TESTING.md)
- GPT／Codex 共用交接：[docs/AI_HANDOFF.md](docs/AI_HANDOFF.md)

程式提交、網站部署、真實雙人手機測試是三種不同狀態。目前不能由本機測試推論雲端資料庫已接通。使用者已建立 Supabase 專案，且畫面顯示初始化 SQL 執行成功；兩個帳號與伺服器環境仍待確認。使用者已授權 NAS 部署，但 NAS 位址與存取尚未確認，尚未部署。

## 開發

```sh
npm ci
npm run check
npm test
npm start
```

需要 Node.js 20 以上。程式不自動讀取 `.env`，請在執行環境設定 [.env.example](.env.example) 的變數。手機鏡頭與麥克風需要 HTTPS；本機 localhost 例外。

## 私人聊天與資料保存

訊息原文、語言、伺服器時間、已驗證發送者及唯一 ID 存於 PostgreSQL。使用相同訊息 ID 重試可避免重複寫入；歷史紀錄採游標分頁。離線一方不需要保持 WebSocket 連線，另一方的訊息仍先寫入資料庫再確認送出。

身分愛心與房間碼都不是登入驗證。API 與 WebSocket 必須驗證登入者、兩人允許名單及房間成員資格；其他帳號即使取得房間碼也不能讀取歷史。資料庫沒有配置或連線失敗時，不得以記憶體、LocalStorage 或檔案冒充已永久保存。

瀏覽器可記住登入工作階段、語言與愛心，重新開啟後先驗證登入，再恢復有權限的房間。清除瀏覽器資料或登出不應刪除 PostgreSQL 的訊息；清除登入資料後需要重新登入。此程式**沒有實作端對端加密**，不要作出相關宣稱。

## 通話與翻譯

通話訊號以 callId 與角色檢查隔離。文字聊天、語音暫時字幕及完成字幕分開，翻譯不阻塞 WebRTC 媒體；翻譯服務失敗時保留原文，進行中的通話應繼續。通話保留對方原聲，不播放 AI 翻譯語音。

連線診斷顯示 RTT、遺失率、抖動及視訊統計，不顯示完整 ICE candidate 或 IP。差網路下優先降低視訊負載；Safari 是否支援完整調整與持續語音辨識，仍需兩支手機實測。沒有配置 TURN 時不能保證跨 NAT／行動網路接通。

## 環境與費用

| 變數 | 用途 |
| --- | --- |
| `SUPABASE_URL`、`SUPABASE_ANON_KEY` | 專案網址與可公開的用戶端金鑰；實際資料存取仍需驗證。 |
| `SUPABASE_SERVICE_ROLE_KEY` | 僅伺服器使用，不能加入前端、GitHub、日誌或聊天。 |
| `PRIVATE_USER_IDS` | 恰好兩個經確認的 Auth 使用者 UUID，以逗號分隔。 |
| `OPENAI_API_KEY`、`OPENAI_MODEL` | 後端翻譯；預設模型 `gpt-4.1-mini`。API 費用與 ChatGPT 會員分開。 |
| `STUN_URLS` | 可選 STUN 設定。 |
| `TURN_URLS`、`TURN_USERNAME`、`TURN_PASSWORD` | 可選自備中繼服務；可能依流量收費。 |
| `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` | 可選推播；目前訂閱仍在記憶體，尚非可靠背景來電服務。 |
| `BUILD_SHA`、`TRUST_PROXY`、`PORT` | 部署版本、可信代理及連接埠設定。 |

程式不會替使用者建立付費服務。Supabase 與 Render 各有方案、額度及暫停規則；資料庫獨立於 Node 程序和 Render 暫存磁碟，所以重新部署應保留資料，但仍需依方案安排備份與還原驗證。舊的 `ROOM_DATA_PATH` 檔案模式不作為此次私人聊天室的持久化方案。

依工作流程先在 LAB 驗證；不得自動更新舊測試站，也不得在未確認的情況下部署到 NAS。
