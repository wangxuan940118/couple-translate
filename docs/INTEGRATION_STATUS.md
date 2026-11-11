# 整合版本與驗證界線

本分支保留 main 的封面、原始圖片、十種語言、聊天室、搜尋、相機功能及原聲語音／視訊通話；整合 PR #12／#13 的 Email OTP 與私人歷史紀錄，並接續 PR #16 的雙向字幕修正。介面依最新要求使用奶油淺色，不包含 PR #14 的深色改版。

## 合併與上線是兩件事

- 不向正式 Render 發送部署請求，不對雲端資料庫自動執行 SQL。
- 此 Node.js／WebSocket 版本不能直接替代目前 Cloudflare Worker 的 LAB 執行環境。LAB 與 Render 的版本狀態必須分別核對。
- main 可能由 Render 的原生 Auto-Deploy 監看；GitHub Actions 的可選部署開關不能關閉 Render 原生自動部署。尚未確認該設定前，不能把合併 main 稱為「不會上線」。
- 本地程式測試通過不等於 Supabase 正式設定、Email 投遞、Render 部署、兩支 iPhone 或跨國通話已通過。

## 私人歷史紀錄一次性設定

1. 先在 Supabase SQL Editor 執行 **檔案內容** `supabase/preflight.sql`，不要把 GitHub 網址當 SQL 貼上。這是唯讀檢查。若列出 `olw_private` 或未知結構，先停止並審查遷移，不能刪除舊資料。
2. 確認沒有需要保留的衝突結構後，依序審查並執行 `supabase/schema.sql`、`supabase/private-foundation.sql`。其中有保護性檢查；失敗時應保留錯誤並處理原因，不能繞過保護。
3. 在 Supabase Authentication 預先建立兩位使用者，確認 Email，記下兩個 User ID。應用程式禁止自行註冊，白／黑愛心不是登入驗證。不要把對方加入資料庫管理團隊來代替應用程式登入。
4. 確認 Email OTP 長度為 **8 碼**，Email 範本包含 `{{ .Token }}`。Supabase 預設郵件服務有收件人與寄信限制；必要時在供應商平台設定自己的 SMTP。實際投遞尚未驗證。
5. 在 Render Environment 設定 `.env.example` 的 Supabase URL、**publishable／anon 公開金鑰**、兩個 UUID 的 `PRIVATE_USER_IDS`（逗號分隔），以及翻譯用 `OPENAI_API_KEY`。此版本不需要 Supabase Service Role Key；不要填入 secret／service_role，也不要把金鑰貼到聊天或 PR。
6. 部署後核對 `/api/health` 的 commit；`/api/ready` 應回應 200。但 ready 只證明設定與 schema 探測通過，不能代替登入後寫入、離線訊息及重新啟動的完整驗證。

使用者 JWT、成員權限與資料庫 RLS 一起保護歷史紀錄。訊息在資料庫確認保存後才標成已保存。這不是端對端加密；保留與備份政策仍需正式設定。

## 兩支 iPhone 必測

使用測試環境與無私人內容的測試句。A 選繁體中文，B 選 English；兩台用 Safari 開啟，允許麥克風並使用耳機。

1. A 撥語音，B 接聽；兩邊各啟動字幕。A 說中文，B 應看到中文原文與英文譯文；B 說英文，A 應看到英文原文與繁中譯文。
2. 交替說至少 20 句並停頓 30 秒後繼續，確認字幕持續、沒有重複、錯序、自己的話冒充對方。
3. 拒絕或關閉語音辨識權限，確認原因與重啟按鈕可見；恢復權限後重新啟動。字幕失敗期間原聲通話應繼續。
4. 視訊重做相同步驟，檢查字幕與掛斷鍵不遮住主要畫面；直向、橫向、小螢幕與放大文字也要檢查。
5. 切到背景再回來、關閉／開啟麥克風及切換網路。iOS 可能暫停辨識，須清楚提示並能手動恢復，不得宣稱可在背景持續辨識。
6. 掛斷確認相機／麥克風釋放，重撥不出現上一次字幕；翻譯 API 逾時或無額度不能中斷原聲。
7. 測試非授權帳號不能讀取房間；雙方關閉頁面、離線傳訊及重新部署後再次登入，確認紀錄仍存在。

以上手機與雲端驗收尚未完成。沒有兩台真實 iPhone 的自動測試結果不可標成完成。

## 費用與部署設定

既有 OpenAI 翻譯按 API 用量計費；ChatGPT 訂閱不提供 API 額度。Supabase、Render、SMTP 與 TURN 的免費額度或用量費用由各服務方案決定，這次程式修改沒有建立付費服務。

自動部署的兩種方式與必要 GitHub／Render 設定見 [AUTO_DEPLOY.md](AUTO_DEPLOY.md)。目前只有工作流程程式與測試，尚未驗證 Render 管理介面設定或真正的部署勾子。
