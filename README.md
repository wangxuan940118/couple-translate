# Our Little World

私人雙人聊天室：保留情侶封面、十種語言文字翻譯與原聲語音／視訊，使用 Email OTP、成員權限與 PostgreSQL 保存訊息。最新介面方向為奶油淺色。

此分支為整合測試版本。請先閱讀 [整合與手機驗收說明](docs/INTEGRATION_STATUS.md)；不能將本地測試通過視為正式部署或兩支 iPhone 已實測。

```sh
npm ci
npm run check
npm test
npm start
```

私人登入與聊天需要 `.env.example` 列出的伺服器環境變數及已審查的 Supabase schema。設定不足時封閉私人資料存取，不退回匿名或記憶體聊天室。不要把真實 `.env`、API Key、JWT 或房間邀請提交到版本庫。

CI 與選用的 Render 自動部署請看 [部署說明](docs/AUTO_DEPLOY.md)。正式 main 的原生自動部署設定必須另外確認。
