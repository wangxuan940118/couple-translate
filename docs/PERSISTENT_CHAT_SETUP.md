# PostgreSQL 私人聊天室設定

這份操作需要建立 Supabase 專案及兩個登入帳號。程式碼完成或本機測試通過，不代表現有 Render 網站已連上資料庫。不要把密碼、service_role 金鑰或翻譯 API Key 貼在聊天裡。

## 1. 建立資料庫

1. 開啟 [Supabase Dashboard](https://supabase.com/dashboard)，建立專案。可先依當下提供的免費方案測試，建立時確認所選方案；程式不會自動啟用付費方案。專案資料庫密碼請放在自己的密碼管理工具。
2. 等待專案就緒，開啟 **SQL Editor → New query**。
3. 從已提交版本開啟 [`supabase/private-chat.sql`](../supabase/private-chat.sql)，完整貼入並執行。這是此功能的遷移，不要以先前規劃用的 `schema.sql` 代替。
4. SQL 使用獨立的 `olw_private` schema，建立房間、成員及訊息與必要 RPC。一般用戶端無權直接讀取表格或執行伺服器用 RPC；伺服器必須先驗證帳號，RPC 再檢查成員資格。金鑰不得替代這些權限檢查。

## 2. 建立並限制兩個帳號

1. 到 **Authentication** 的登入方式設定，啟用 **Email OTP**。
2. 關閉允許新使用者註冊的選項。網站也沒有公開註冊入口。
3. 到 **Authentication → Users** 建立兩個帳號，使用兩人各自控制的 Email。由管理者建立兩位帳號，確認各自 Email 已驗證；網站以 Email 收取 8 位數驗證碼登入，不需要共用密碼。
4. 在 Users 清單取得兩個使用者的 **User UID／UUID**。設定允許名單使用 UUID，不使用姓名、愛心、Email 字串或房間碼。
5. 在 Authentication → Email Templates 將 Magic Link 範本中的連結改為 `{{ .Token }}` 驗證碼，並將 OTP 長度設為 8 位。確認寄信額度與 SMTP 是否允許寄送給兩個不同 Email。網站不提供公開註冊；第二個帳號需先由管理者建立。

## 3. 設定伺服器環境

在 Supabase 專案設定取得 **Project URL**、可公開的 **anon key** 及私密的 **service_role key**。目前此版本以這組相容金鑰命名；若 Dashboard 同時提供其他新式金鑰，請使用程式要求的值。

在獨立測試服務的 **Render → Environment** 填入：

```text
SUPABASE_URL=https://你的專案.supabase.co
SUPABASE_ANON_KEY=你的 anon key
SUPABASE_SERVICE_ROLE_KEY=你的 service_role key
PRIVATE_USER_IDS=第一個使用者UUID,第二個使用者UUID
```

上面只有格式示意。真實值直接存入平台的環境設定，不加入 GitHub，不貼在此文件，也不要截圖分享。

- `service_role` 只供後端使用；前端不能取得。
- 用戶端登入會取得 Project URL 與 **可公開的 anon key**，它不是伺服器管理金鑰，不應授予未登入者讀取私人資料的能力。
- 既有翻譯仍需原本後端 `OPENAI_API_KEY`；請保留其設定。TURN 與推播的設定也保留，勿因加入資料庫而刪除。
- 此程式不自動讀取 `.env`。本機需由啟動環境匯入變數，平台則使用其 Environment 設定。

## 4. 部署與登入

依專案規範先更新 LAB 測試環境，保留公開入口；登入驗證在私人聊天室內完成，不要求對方持有 ChatGPT 帳號。現有 LAB 是 Worker／D1 架構，不能把 Node.js 的 `server.js` 當成 Worker 直接部署；需要相容的測試服務或經測試的整合。

Render Node 服務使用 `npm ci` 建置、`npm start` 啟動，健康檢查使用 `/api/health`。比對其回報的 commit 與已核准提交，不要單憑首頁能開啟就當成版本部署成功。未配置資料庫時應明確回報設定不足，不能降級成會遺失紀錄的假永久模式。

兩人用各自帳號登入，選擇自己的愛心及語言，再使用同一組私人房間碼。重新開啟網站時，先恢復並驗證登入，再載入有權限的房間及歷史紀錄。房間碼仍請私下分享；它不能讓第三人跳過登入與成員檢查。

目前 NAS 的型號、位址與部署存取皆未確認。使用者現已授權部署整理好的版本，但尚未確認 NAS 主機與存取方式，因此這份設定不表示已連上或完成 NAS 部署。

## 5. 完成後必做的驗收

依 [`TESTING.md`](TESTING.md) 的 A／B／C 測試執行：雙方關閉重開、離線收信、伺服器重啟、Render 重新部署、第三人拒絕存取及歷史分頁。確認上述行為後，才可說該雲端版本通過持久化驗收。

PostgreSQL 訊息保存獨立於瀏覽器與 Node 程序。LocalStorage 用於登入工作階段、語言、愛心與尚未收到儲存確認的待傳佇列。只有伺服器確認寫入 PostgreSQL 的訊息才標為已儲存；裝置佇列不作為歷史紀錄的唯一來源。清除 Safari 網站資料後重新登入，雲端紀錄仍應存在。

## 費用與維護

Supabase 免費方案的容量、流量、閒置暫停及備份規則以建立當下的官方說明為準。Render 免費服務也可能休眠，造成第一次連線較慢；資料庫仍是獨立服務。這些都不是已啟用付費的通知。

長期使用需要定期匯出／備份並實際驗證還原。不要把「重新部署仍能讀取」解讀為不需要備份或保證永不遺失。TURN 中繼與 LLM API 各自可能產生費用，ChatGPT 訂閱不包含 API 額度。
