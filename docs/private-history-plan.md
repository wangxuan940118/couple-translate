# Our Little World — private accounts and permanent history

## Current state (2026-11-11)
The live site still uses a shared room code and **ephemeral WebSocket chat**. It does **not** persist chat messages, authenticate two named accounts, or back up messages. This branch prepares the database security foundation **without changing the live chat flow**.

## Safe implementation order
1. **Protect existing data and secrets.** Save a copy of the existing GitHub code; verify Render environment secrets are server-only. Never paste a Supabase service-role key into GitHub or browser JavaScript. Do not assume that chat history which disappeared on refresh can be recovered.
2. **Create a private Supabase project.** Enable Supabase Auth with email sign-in for two real accounts. Disable public sign-up once the two accounts are created; enforce MFA where available. Configure allowed redirect URLs for the Render domain.
3. **Apply SQL in order.** Run `supabase/schema.sql`, then `supabase/private-foundation.sql` in the Supabase SQL editor. Test as two authenticated accounts: owner can create a room; owner is automatically added; owner can issue a 24-hour single-use invitation; partner can redeem it; third account cannot join or read messages. Test RLS against messages, members, invites and attachment storage before adding real personal data.
4. **Implement login and authenticated transport.** Replace room-code-only trust with verified Supabase Auth JWTs. Validate membership server-side before accepting chat/WebSocket joins or history requests. Device count is not an identity boundary. Keep current chat/call UI while migrating. Do not deploy the new authentication flow until both accounts can sign in.
5. **Persist and synchronize messages.** Store each message with client-generated UUID, authenticated sender UUID, room UUID, body and timestamp; server confirms database commit before reporting 'saved'. Load paginated history on join, order by created_at and id, deduplicate across multiple devices, and use realtime subscriptions or authenticated WebSocket fanout. Explicitly handle failed writes and offline retries. Existing translation UI can remain a view of stored original text.
6. **Backups and restore tests.** Enable provider-managed database backups/PITR if included in your chosen plan. Schedule encrypted logical backups to a separate protected destination and test restoring to an isolated database. Store encryption keys separately from backups. Document retention, deletion, and export policies. A backup is only reliable once a restore has been tested.
7. **Cutover.** After end-to-end tests with two accounts, three devices, refresh, reconnect, server restart and recovery, deploy the new backend and frontend together. Keep a rollback commit and take a pre-cutover database snapshot.

## Important security notes
- The legacy room code is **not a private account**. Existing WebSocket join and translation endpoints need additional authentication before sensitive messages can be considered private.
- SQL row-level security protects direct Supabase data access, but **does not automatically secure the current Node WebSocket server**.
- Do not create open `room_members` insert policies or put `service_role` in the client.
- Do not assume that free-tier hosting has durable local disk or included point-in-time backups.
- The proposed schema is **not end-to-end encrypted**. Database operators with elevated access may be able to read message bodies; E2EE would be a separate design.
- A previously used room code should be rotated once secure account-based access is live.

## Next configuration required
A Supabase project URL and **public anon/publishable key** (not secret) are needed for browser login. A safe server-side credential strategy and verified user accounts are needed before wiring the application. Do not share passwords, recovery codes, private API keys or service-role keys in chat.
