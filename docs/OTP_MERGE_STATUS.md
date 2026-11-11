# Integration status — Codex private chat + email OTP

This branch starts from `codex/private-chat-history` and replaces the visible email/password login with an eight-digit Supabase Email OTP flow. It preserves Codex's server-side private room membership checks, PostgreSQL history adapter, and WebSocket authentication. **It is not deployed.**

## Changes
- `public/auth.js`: adds `sendOtp(email)` using `/auth/v1/otp` with `create_user:false`, and `verifyOtp(email,token)` using `/auth/v1/verify`. Successful verification reuses the existing session refresh and `/auth/v1/user` validation.
- `public/index.html`: changes login form to email + eight-digit code.
- Does not automatically merge PR #12/#13 SQL because they use a **different database schema** (`public.rooms/messages` versus `olw_private.rooms/messages`). Applying both would create competing persistence paths. The Codex `supabase/private-chat.sql` schema remains authoritative for this integration.

## Required before merging/deployment
1. Update `docs/PERSISTENT_CHAT_SETUP.md`: current password instructions are outdated for this branch. Email OTP template must use `{{ .Token }}` rather than default magic-link `{{ .ConfirmationURL }}`. The configured OTP length must be eight digits.
2. Confirm Supabase Email OTP delivery for **both authorized accounts**. Default SMTP may not deliver to the second account. If registration is disabled, the second account must be created by an authorized admin before requesting a code.
3. Run `npm ci && npm run check && npm test`. Existing password-specific tests may need updates; do not claim passing tests without running them.
4. Rebase against current `main` and reconcile 50+ commits of UI, WebRTC and other changes. **Do not overwrite the live UI or deploy the stale branch directly.**
5. Test real Supabase migration and message read/write, unauthorized account rejection, offline history, Safari session restore, Render restart, and both devices' calls.
6. Set server-side environment values securely, verify deployment SHA, and establish encrypted offsite backup/restore testing before claiming permanent retention.

This branch is a **working integration proposal**, not a production-ready merge.
