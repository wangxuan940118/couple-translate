# Email OTP and durable chat — integration checklist

**Status: staged code only, not deployed.** The live legacy room-code WebSocket must not be considered authenticated.

## Supabase settings (no payment required for basic Auth)
1. Authentication → Providers → Email: keep Email enabled.
2. Authentication → URL Configuration: site URL `https://couple-translate.onrender.com/`; add the same domain to Redirect URLs.
3. Authentication → Email Templates → Magic Link: to receive a numeric OTP instead of a click-only link, use the Supabase token placeholder **`{{ .Token }}`** in the message body, for example `Your login code: {{ .Token }}`. The default `{{ .ConfirmationURL }}` sends a clickable link, not a code. Do not expose any API secret in a template.
4. Test deliverability. Supabase's built-in email sender is restricted/rate-limited and may not deliver to arbitrary partner addresses without configuring SMTP. Do not assume successful `signInWithOtp` means mail was delivered. Use an approved SMTP sender when required.
5. Auth OTP length is set to 8 digits in the user's dashboard. Match that length in the UI.

## Private account + message access (required before activation)
- Review `supabase/schema.sql` and draft `supabase/private-foundation.sql`; apply in a **test Supabase project or staging environment** first, after checking for existing tables.
- Test owner room creation, one-time invitation redemption by partner, invitation expiration and unauthorized third-account rejection.
- Implement and verify server-side JWT authentication on **every WebSocket upgrade/join** and on all private endpoints, not merely in the browser. Map authenticated account to room membership and prevent legacy code-only bypass.
- Do not treat device IDs, profile selector, room codes, or client-supplied sender IDs as authentication.
- `private-history.js` is an unconnected adapter for authenticated message load/save and realtime notifications. Wire it into the UI only after access controls pass.
- Save a message **before** reporting it as durably stored; use stable UUIDs for retries. Test multi-device ordering and duplicate suppression.
- Enable database Realtime publication for the messages table if using postgres_changes and verify RLS applies to the subscriber.
- Keep the current cover, home page, translation, audio/video UI. WebRTC signaling needs explicit authenticated sender/recipient routing before secure launch.
- Supabase public publishable/anon keys may be sent to browsers; **service_role and database passwords never may**. Configure Render server-side environment separately, after secure backend implementation.

## Backups
- Supabase free tier does not guarantee managed backups or PITR.
- Implement encrypted automated offsite backups with separately stored credentials and retention policy; test restoring to an isolated database before claiming 'automatic backup' or 'permanent'.
- Never store database dumps in GitHub or public artifacts.

## Activation
Do not merge this draft PR into main or set `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` in production yet. The feature flag only displays the email screen; it does **not** secure the existing WebSocket, and currently blocks navigation to chat after login. Complete the secure cutover and end-to-end tests first.
