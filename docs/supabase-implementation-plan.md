# Supabase sync — Phase 1 implementation plan

Status: proposed, ready for review. No runtime code has been changed yet.

`docs/supabase-setup.md` remains the platform/deployment reference. This file is the build plan and
the source of truth for Phase 1 scope.

## 1. Locked decisions

| Area         | Decision                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data model   | Snapshot first. Keep `S.data` as the single JSONB document; normalize in Phase 2.                                                                                   |
| Auth         | Email and password only. No social providers, magic links, or passkeys in Phase 1.                                                                                  |
| First login  | Import existing `gr8r.v2` data when no remote workspace exists. Otherwise use onboarding/seed.                                                                      |
| Tenancy      | One workspace per user in the UI. Invites, multiple workspaces, and private-project RLS are Phase 2.                                                                |
| Secrets      | Browser gets `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. A secret key never enters `src/` or a `VITE_*` variable.                                      |
| Preferences  | Workspace data syncs. Theme, density, locale, and other device preferences stay local.                                                                              |
| Tests        | None added. The repo has no test runner, test files, or test script. CI stays lint + format + build.                                                                |
| Comments     | No new banner comments or obvious explanations. Comment only the PKCE/hash-router constraint, optimistic-concurrency handling, and security-sensitive RLS/RPC code. |
| Dependencies | Add `@supabase/supabase-js` only. No UI framework, state library, or ORM.                                                                                           |

## 2. Repository findings

- The app is plain JavaScript ES modules plus CSS, bundled by Vite. There is no runtime dependency
  today and no framework.
- `src/core/store.js` owns all app state in `S.data`. `save()` debounces a `localStorage` write to
  `gr8r.v2`; `mutate()` wraps a change with `save()` and `render()`.
- `src/main.js` boots synchronously in an IIFE and renders immediately. Supabase boot must become
  async so a signed-in user does not briefly see the login screen.
- The auth, onboarding, and account screens are currently prototypes. `A.doLogin`, `A.doSignup`,
  `A.doForgot`, `A.doReset`, `A.socialAuth`, `A.verified`, `A.resend`, and `A.signOut` use timers.
- `A.onbFinish()` creates the workspace and first project locally. It must become async and call
  `create_workspace` after the local setup mutation.
- No test framework exists:
  - no `test` script in `package.json`
  - no `*.test.*`, `*.spec.*`, `__tests__`, `tests`, or `e2e` files/directories
  - no Vitest, Jest, Playwright, or Cypress configuration or dependency
  - `.github/workflows/ci.yml` runs `npm run lint`, `npm run format:check`, and `npm run build` only
- The app uses hash routing. That is why the client must use PKCE, which returns a `?code=` query
  parameter instead of tokens in `location.hash`.
- Code conventions: single quotes, semicolons, 2-space indentation, 160-column print width, short
  named helpers, `$`/`$$`, `esc`, `toast`, `mutate`, `render`, and the `A`/`IN` action tables.
- New files should follow those conventions. Do not introduce default exports, classes, TypeScript,
  or a second state container.

## 3. Architecture

```
Browser (Vite SPA on Vercel)
  ├── @supabase/supabase-js with the publishable key
  ├── Supabase Auth (PKCE, email/password)
  ├── PostgREST reads + two RPCs for writes
  └── Realtime subscription on workspace_state
            │
            ▼
Supabase Postgres
  ├── workspaces           tenancy row: name + unique slug
  ├── workspace_members    auth user ↔ workspace, role, member_key
  └── workspace_state      S.data JSONB + bigint version
```

Boot flow:

```
await getSession()
  ├─ no session -> login / signup / forgot / verify screens
  └─ session
      -> loadWorkspace()
          ├─ no membership -> import gr8r.v2 or start onboarding
          └─ membership -> read workspace_state -> hydrate S.data -> render
```

Save flow:

```
mutate() -> save() -> queueSave(S.data)
                       -> save_workspace_state(workspace_id, expected_version, state)
                       -> success: update version + cache
                       -> conflict: stop retrying, offer reload
                       -> network error: retry with backoff, show offline bar
```

Realtime flow:

```
workspace_state UPDATE
  -> if no local pending save and remote version is newer
  -> replace S.data, update cache/version, render
```

The snapshot remains workspace-level. Every member of a workspace can read the whole snapshot,
including projects marked private. Phase 1 is single-user per workspace, so this is acceptable for
the sync milestone but must not be presented as project-level security.

## 4. Database

Create `supabase/migrations/<timestamp>_init_workspaces.sql`. Use the SQL in
`docs/supabase-setup.md` §Step 4, with the scope reduction below.

### Tables

- `workspaces`: `id uuid`, `name`, unique `slug`, `created_by -> auth.users(id)`, timestamps.
- `workspace_members`: `(workspace_id, user_id)` primary key, `member_key`, `role`, timestamps,
  unique `(workspace_id, member_key)`, index on `user_id`.
- `workspace_state`: `workspace_id` primary key, `state jsonb`, `version bigint`, `updated_at`,
  `updated_by`.

`workspace_members.member_key` maps an auth user to the snapshot's `S.data.me`. The imported data
normally uses `m1`; onboarding uses the seed's `me` value.

### RLS and grants

- Enable RLS on all three tables.
- `workspaces`: select for workspace members; update for owners/admins. Grant only
  `update (name, slug)` to `authenticated`.
- `workspace_members`: select for workspace members. No client inserts, updates, or deletes.
- `workspace_state`: select for workspace members. No client inserts, updates, or deletes.
- Revoke all from `anon` and `authenticated`, then grant the minimum select/update described above.
- Use private `security definer` helpers with `set search_path = ''` for membership and role checks.
  These checks are the one place where a short SQL comment is justified.

### RPCs

- `public.create_workspace(p_name text, p_slug text, p_member_key text, p_state jsonb default '{}')`
  - Requires an authenticated user.
  - Validates that `p_name`, `p_slug`, and `p_member_key` are non-empty and `p_state` is a JSON object.
  - Creates the workspace, the owner membership, and version 1 of the state in one transaction.
  - Returns the new workspace UUID.
- `public.save_workspace_state(p_workspace_id uuid, p_expected_version bigint, p_state jsonb)`
  - Requires membership.
  - Validates that `p_state` is a JSON object.
  - Updates only when `version = p_expected_version`; increments the version and returns it.
  - Raises SQLSTATE `40001` on a version conflict.
- Revoke all on both functions from `public`, then grant execute to `authenticated`.

Do not add `set_member_role`, invites, or normalized entity tables yet. Phase 1 has a single owner
and no member-management UI.

### Realtime

Add `public.workspace_state` to the `supabase_realtime` publication. Realtime respects RLS, so the
member select policy is the authorization check. The client only needs `UPDATE` events; ignore
`INSERT` and `DELETE`.

## 5. Client modules

### New: `src/core/supabase.js`

- Read `import.meta.env.VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- Export `supabaseEnabled` and a single `supabase` client, or `null` when either variable is absent.
- Configure `persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: true`, and
  `flowType: 'pkce'`.
- Do not import a secret key, service role, or server-only code.

When the env vars are absent, the app keeps the current `localStorage` behavior. That keeps local
development and the demo build usable before a Supabase project exists.

### New: `src/core/persistence.js`

Single responsibility: Supabase session, workspace loading, versioned saves, cache, and Realtime.

| Export                                              | Responsibility                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `getSession()`                                      | Return the current Supabase session.                                                                |
| `loadWorkspace()`                                   | Return `{ needsAuth }`, `{ needsWorkspace, user }`, or `{ workspace, membership, state, version }`. |
| `createWorkspace({ name, slug, memberKey, state })` | Call `create_workspace`; set the active workspace/version; write cache.                             |
| `saveWorkspaceMeta({ name, slug })`                 | Update `workspaces.name` / `workspaces.slug` for settings.                                          |
| `queueSave(state)`                                  | Debounce and submit the latest snapshot.                                                            |
| `flushSave()`                                       | Await any pending save; used before sign-out and on `visibilitychange`.                             |
| `retrySync()`                                       | Retry after a network failure; used by the existing offline bar.                                    |
| `subscribeWorkspace(onState)`                       | Subscribe to `workspace_state` updates for the active workspace.                                    |
| `unsubscribeWorkspace()`                            | Remove the channel and clear workspace-local state.                                                 |
| `getWorkspaceId()`                                  | Return the active UUID for settings/guards.                                                         |
| `clearCloudCache()`                                 | Remove the cache on explicit sign-out.                                                              |
| `setSyncNotifier(fn)`                               | Register the app's status callback; avoids a `store -> persistence -> store` import cycle.          |

Cache shape in `gr8r.v3.cache`:

```text
{
  workspaceId,
  userId,
  state,
  version,
  at
}
```

`gr8r.v2` remains the local-only fallback. `gr8r.v3.cache` is the last known remote snapshot and is
used for a fast/offline read. Do not treat the cache as a durable outbox in Phase 1: pending saves
retry while the tab is open, but a reload while offline may drop unsynced edits. State that
limitation explicitly.

**Key cleanup.** After the first successful `save_workspace_state` confirms a sync, delete the legacy
`gr8r.v2` key from localStorage. This prevents two data copies from drifting apart if the user
switches between cloud mode (env vars present) and local mode (env vars absent). Add a one-liner to
the `queueSave` success path:

```js
// On first confirmed sync, remove the legacy key so local-back-and-forth
// does not produce two independent data copies.
if (localStorage.getItem('gr8r.v2')) {
  localStorage.removeItem('gr8r.v2');
}
```

This runs once. If the user later removes the env vars, `load()` will fall through `readCache()`
(then `seed()`) instead of loading stale `gr8r.v2` data that no longer matches the remote snapshot.
The `gr8r.v3.cache` always contains the last known good state.

Save rules:

- Do not queue a save until `createWorkspace` or `loadWorkspace` has set an active workspace.
- Debounce for 250 ms. Keep only the latest state.
- Never run two RPCs for the same workspace at once. If a new state arrives during a save, submit it
  after the current request finishes.
- On success, store the returned version and mark the cache clean.
- On `40001`, stop automatic retries and notify the app. The user can reload the remote snapshot or
  retry manually.
- On `42501` / `PGRST301`, stop retrying and notify the app; the session is no longer valid.
- On network/5xx errors, retry with capped exponential backoff and set the offline status.
- Reject a snapshot larger than 900 KB with a toast. This is well above the current ~31 KB but below
  common request limits.
- `mutate()` calls `save()` then `render()` synchronously. In cloud mode `save()` is fire-and-forget:
  the UI paints optimistically and `queueSave` handles the RPC in the background. A failed save
  (conflict, auth error) shows stale data until the next render or a manual reload. The conflict
  toast and "Reload" handler (§3) are the recovery path. If optimistic-paint + rollback becomes a UX
  concern, convert `mutate` to async and revert `S.data` on save failure.

### Edit: `src/core/store.js`

- Load `S.data` from `readCache()?.state`, then `saved?.data`, then `seed()`.
- Keep `S.prefs`, `S.views`, and `S.ui` exactly as they are, except:
  - after hydration, set `S.prefs.name` and `S.prefs.title` from the current member so the sidebar,
    greeting, and profile form match the synced snapshot on a new device.
- Keep writing the local fallback to `gr8r.v2` for local-only mode.
- In Supabase mode, `save()` should also call `queueSave(S.data)`.
- Do not change the shape of `S.data` or the `D()`, `me()`, `mem()`, `proj()`, and `task()` helpers.

### Edit: `src/main.js`

- Replace the synchronous IIFE with `async function boot()` and call `boot()`.
- Register `supabase.auth.onAuthStateChange` immediately after imports.
- Do not make the auth callback async. Push work to `setTimeout(() => handleAuthEvent(...), 0)` so
  Supabase is not called from inside its own callback.
- Await `getSession()` before the first real render.
- If there is no session, choose the auth screen from the hash and render. Treat `onboarding`,
  `verify`, and `reset` as session-required: show login unless there is a pending verification email
  or a recovery session.
- If there is a session and `?type=recovery` is present, show the reset screen instead of the app.
- If there is a session, call `loadWorkspace()`:
  - `needsWorkspace` plus legacy `gr8r.v2` data: import.
  - `needsWorkspace` without legacy data: onboarding.
  - existing workspace: hydrate, subscribe to Realtime, and render.
- On boot failure, render the cached data with the offline bar and show a toast. Do not render a
  blank screen.
- Keep the existing dev-only `window.__gr8r` handle.

### Edit: `src/actions/actions.js`

- Add `busyBtn(id, fn)` next to `loadingBtn`. It adds `is-loading`, sets `aria-busy`/`disabled`,
  awaits `fn`, and restores the button in `finally`. Keep `loadingBtn` for the remaining prototype
  timers.
- Convert `enterApp` to async and make it hydrate the workspace before navigating.
- Wire auth, onboarding, sign-out, password, and workspace-name actions as described below.
- Guard reminder: the action table handlers are called without `await` by `events.js`; async actions
  are fine because they manage their own button state and render after completion.

### Edit: `src/pages/auth.js`

- Hide the social buttons while email/password is the only enabled provider. Do not leave buttons
  that pretend to sign in.
- Remove the prototype-only "Open reset link" shortcut from the forgot-password state. The real
  email link is the only path.
- Keep the existing `login`, `signup`, `forgot`, `forgot-sent`, `reset`, `reset-done`, `verify`, and
  `onboarding` states so styling and routing do not change.
- Default the email field to an empty string in cloud mode instead of `hello@gr8rstudio.com`.
- Keep the pending verification email in `sessionStorage` so a refresh on `#verify` can still resend.

### Other edits

- `src/overlays/popovers.js`: in cloud mode, show the single active workspace and hide "Create
  workspace" and "Invite members". One workspace per user is the Phase 1 contract.
- `src/shell/layout.js`: reuse the existing offline bar for sync failures. Do not add a second sync
  banner unless the existing copy is insufficient.
- `src/pages/settings.js`: no structural change. The existing password form already has current,
  new, and confirm fields.
- `package.json` / `package-lock.json`: add `@supabase/supabase-js`.
- `README.md`: add a short cloud-sync setup note after implementation, pointing at `.env.example`
  and `docs/supabase-setup.md`.

## 6. Auth behavior

| Action              | Supabase call                                                                    | Result                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Sign in             | `signInWithPassword({ email, password })`                                        | Hydrate workspace and enter app, or show an inline error.                                                                 |
| Sign up             | `signUp({ email, password, options: { data: { full_name }, emailRedirectTo } })` | Session present: enter app. No session: show verify screen and start resend cooldown.                                     |
| Resend verification | `resend({ type: 'signup', email, options: { emailRedirectTo } })`                | Restart cooldown; show a neutral confirmation.                                                                            |
| Verify check        | `getSession()`                                                                   | Enter app if a session exists; otherwise explain that the link must be opened on this device.                             |
| Forgot password     | `resetPasswordForEmail(email, { redirectTo })`                                   | Always show the same `forgot-sent` state; do not reveal whether an account exists.                                        |
| Reset password      | `updateUser({ password })`                                                       | Show `reset-done`, clear the recovery query, sign out, and require a fresh login.                                         |
| Sign out            | `signOut()`                                                                      | Flush pending saves, unsubscribe, clear cloud and legacy cache, reset in-memory state, reload to login.                   |
| Change password     | `updateUser({ email: session.user.email, current_password, password })`          | Show existing success/error states. Requires "Require current password when changing password" in Supabase Auth settings. |

Redirects:

- Signup confirmation: `emailRedirectTo: window.location.origin`
- Password recovery: `${window.location.origin}/?type=recovery`

Both must be listed in Supabase Auth redirect URLs. PKCE keeps the code in the query string, so the
hash router is unaffected. The code verifier is browser-local; opening a confirmation or recovery
link on a different device will not complete the PKCE flow. Document this constraint; use token-hash
templates plus `verifyOtp` only if cross-device links become a requirement.

Auth event handling:

- `PASSWORD_RECOVERY`: set `S.ui.auth = 'reset'`, fill the email from the session user, render.
- `SIGNED_OUT`: set the login screen and clear in-memory workspace state; a reload is acceptable.
- `SIGNED_IN`: do not double-hydrate from the callback. The login handler and boot already hydrate.
  If a deferred event arrives while on `verify` or `login`, schedule `enterApp()` once.
- `TOKEN_REFRESHED`: no UI action.

Error mapping:

- Invalid login: "Email or password is incorrect."
- Unverified email: keep the verify screen and offer resend.
- Duplicate signup with enumeration protection: show the same verify screen.
- Weak password: use the existing inline password rule, not the raw Supabase message.
- Rate limit: "Too many attempts. Try again in a few minutes."
- Network failure: reuse the offline bar/toast, not a raw browser error.

## 7. Import and onboarding

Import runs only when `loadWorkspace()` returns `needsWorkspace` and `saved?.data` exists.

1. Clone `saved.data` with `JSON.parse(JSON.stringify(...))`.
2. Read `memberKey = state.me || 'm1'`.
3. Find the member with that id. Set its `email` to the auth user's email and its `name` to
   `user.user_metadata.full_name` or the email prefix. If the member is missing, add a minimal member
   record so `me()` and assignments stay valid.
4. Read the workspace name and slug from `state.ws`. Sanitize the slug with the same regex used by
   onboarding. If `create_workspace` returns `23505`, retry with a short suffix.
5. Call `createWorkspace({ name, slug, memberKey, state })`.
6. Hydrate, subscribe, delete `gr8r.v2` so the same local snapshot cannot be imported into another
   account, and enter the app with a one-time "Imported your local workspace" toast.

On every successful hydration, set `S.data.me` from `workspace_members.member_key`, mirror the
canonical workspace name/slug into `S.data.ws`, and replace `S.data.workspaces` with a single entry
for the active workspace. The imported demo workspace list must not survive as a fake switcher.

New users without legacy data go through the existing onboarding. On the final step:

1. Apply the existing local setup mutation (workspace name/color, default view, first project).
2. Do not add invite rows or claim invites were sent. Phase 1 has no invite backend.
3. Call `createWorkspace` with the resulting `S.data`.
4. On success, hydrate and navigate to the first project.
5. On a slug conflict, show "That workspace URL is already taken" on the workspace step.

Onboarding rules in cloud mode:

- The invite step becomes a deferred-feature notice or is skipped. Do not show email inputs, "Send
  invites", or a "invitations sent" summary when there is no invite backend.
- `A.onbExit` signs out instead of dropping into an app with no remote workspace.
- `A.newWorkspace` and `A.switchWs` show a "Multiple workspaces are coming later" toast and do not
  mutate the snapshot.
- The green "is available" hint on the URL field is removed unless a real availability check exists.
- Import runs once, on the first device you sign in on. A user who signs in on a second device
  (which has no `gr8r.v2` data from that device) will hydrate from the remote workspace state
  instead. Importing from `gr8r.v2` on the second device is not possible after the first device
  has created the remote workspace, because `loadWorkspace()` returns a membership rather than
  `needsWorkspace`. If the remote state is empty and the user expected to import, they must use
  the export/import workaround — Phase 1 has no "re-import from another device" flow.

## 8. Settings and prototype guards

- `A.saveWorkspace`: update `workspaces.name`/`slug` first, then apply the local snapshot change. If
  the update fails, keep the old value and show an error. The DB row is canonical because boot
  mirrors it into `S.data.ws`.
- `A.saveProfile`: update the current member and `S.prefs` as today. This is snapshot data, so no
  separate table write is needed.
- `A.savePassword`: use the real Supabase call from §6. Map a wrong current password to
  `S.ui.errors.pwCur`.
- `A.retryOnline`: call `retrySync()` in cloud mode; keep the timer for local mode.
- `A.socialAuth`, `A.invite`, `A.shareInvite`, `A.resendInvite`, `A.copyInviteLink`, `A.revokeSession`,
  `A.revokeAll`, and the 2FA actions must not report success when nothing happened. In cloud mode,
  show "Not enabled yet" for unsupported actions. Billing and session/2FA implementation stay out of
  scope.
- Gate the "Simulate offline", "Reset demo data", and "Replay onboarding" prototype controls behind
  `import.meta.env.DEV` so production users cannot write themselves into a fake state.

## 9. File-by-file change list

| File                                                  | Change                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `package.json`, `package-lock.json`                   | Add `@supabase/supabase-js`.                                                          |
| `supabase/config.toml`                                | Create with `supabase init`; commit it.                                               |
| `supabase/migrations/<timestamp>_init_workspaces.sql` | Tables, indexes, RLS, grants, helpers, RPCs, Realtime publication.                    |
| `src/core/supabase.js`                                | New client and `supabaseEnabled` guard.                                               |
| `src/core/persistence.js`                             | New auth/workspace/cache/save/Realtime layer.                                         |
| `src/core/store.js`                                   | Cache initialisation, cloud save routing, profile prefs hydration.                    |
| `src/main.js`                                         | Async boot, auth listener, workspace hydration, sync status.                          |
| `src/actions/actions.js`                              | `busyBtn`, real auth, import/onboarding, sign-out, settings writes, prototype guards. |
| `src/pages/auth.js`                                   | Email-only social handling, real reset/verify states, empty default email.            |
| `src/overlays/popovers.js`                            | Single-workspace cloud menu; hide create/invite actions.                              |
| `src/shell/layout.js`                                 | Reuse offline bar for sync failure; keep local-mode behavior.                         |
| `docs/supabase-setup.md`                              | Reconcile the research guide with these locked decisions.                             |
| `README.md`                                           | Add a short cloud-sync setup section after implementation.                            |
| `.github/workflows/ci.yml`                            | No change. No test job is added.                                                      |

## 10. Implementation order

1. **Database first.** Create the migration, apply it to staging, run the Security Advisor, and
   verify RLS/RPCs manually. Do not start the client against an unsecured table.
2. **Client seam.** Add `@supabase/supabase-js`, `supabase.js`, and `persistence.js`. Keep the app
   running unchanged when env vars are absent.
3. **Boot and session.** Make `main.js` async, await `getSession()`, hydrate `S.data`, and add the
   auth event listener. Verify reload, deep hash routes, and signed-out behavior.
4. **Auth screens.** Wire login, signup, verify/resend, forgot/reset, and sign-out. Add `busyBtn`.
5. **Onboarding and import.** Implement `createWorkspace`, legacy import, and the cloud-mode
   onboarding guards.
6. **Sync.** Wire `save()` to `queueSave`, add Realtime, conflict handling, offline retry, and
   `flushSave` on sign-out/visibility change.
7. **Settings.** Wire workspace rename and password change; add prototype guards.
8. **Deployment.** Configure Supabase Auth URLs, SMTP, rate limits, Vercel env vars, and run the
   manual QA matrix on staging before production.

## 11. Manual verification matrix

No automated tests will be added, per the repository's current setup. Run these checks by hand after
step 8:

### Static

- `npm run lint`
- `npm run format:check`
- `npm run build`
- `grep -R "sb_secret" dist` returns nothing.
- `grep -R "service_role" dist` returns nothing.
- `grep -r "VITE_SUPABASE_SECRET\|VITE_SERVICE_ROLE\|VITE_SERVICE_KEY" src` returns nothing — no
  secret key name is referenced from client code.
- `grep -r "SUPABASE_SECRET_KEY\|sb_secret\|service_role" src` returns nothing — no server-only
  names leak into the bundle.
- CSP `connect-src` directives tested: `https://*.supabase.co` and `wss://*.supabase.co` produce no
  console errors during auth, save, and Realtime operations.

### Local mode

- Start with no `.env.local`. The app boots and behaves exactly as before, using `gr8r.v2`.
- Auth screens still work in prototype mode; no Supabase network calls occur.

### Auth

- Sign up with a new email; verify screen appears; resend cooldown works.
- Open the confirmation link in the same browser; app enters onboarding/import.
- Sign out; reload; login screen appears; sign in again; session persists across reload.
- Wrong password shows an inline error, not a browser alert.
- Forgot password sends a real email; recovery link opens the reset screen; reset succeeds; old
  password fails and new password works.
- Password change with a wrong current password shows the field error; the correct current password
  succeeds.

### Import

- With existing `gr8r.v2` data and no remote membership, sign in. All projects, tasks, comments, and
  members are present; `S.data.me` matches `workspace_members.member_key`; the current member shows
  the auth user's name/email.
- After import, `gr8r.v2` is removed and a second sign-in does not duplicate the workspace.
- With no legacy data, onboarding creates a workspace and first project, and the workspace appears
  after a reload.

### Sync and tenancy

- Edit a task on device A; device B receives the Realtime update and shows it after reload.
- Two tabs writing close together produce a visible conflict toast rather than a silent overwrite;
  "Reload" loads the server snapshot.
- Disconnect the network, edit, reconnect; the pending save retries and the offline bar clears.
- User B cannot read or write user A's workspace through direct REST calls.
- `anon` cannot select any workspace table or execute either RPC.
- Direct `update`/`insert` on `workspace_state` fails; only `save_workspace_state` succeeds.
- A second `save_workspace_state` with an old version returns SQLSTATE `40001`.
- After import, `gr8r.v2` is removed from localStorage. Switching env vars on/off does not create
  two independent data copies.
- Realtime staleness test: write from device A, then immediately subscribe from device B; device B
  receives the latest state (test the subscribe/read race window, §3 mitigation).
- Sign in on a second device: the remote snapshot hydrates correctly; `S.data.me` matches the new
  device's `workspace_members.member_key`.

## 12. Out of scope

- Normalized tables for projects, tasks, comments, members, files, activity, and notifications.
- Invites, email delivery for teammates, roles, guests, and private-project enforcement.
- Multiple workspaces per user and workspace switching.
- Durable offline outbox, cross-device conflict merge UI, and entity-level Realtime patches.
- Social auth, magic links, passkeys, 2FA, session management, and billing.
- Automated tests, test runners, and test CI jobs.

## 13. Risks and limitations

- The snapshot is readable by every workspace member. Do not market private projects as secure until
  Phase 2.
- Phase 1 is single-user per workspace. The UI must not imply invites or multi-user access.
- Realtime is a convenience, not the source of truth. A page reload must always recover from
  `workspace_state`.
- Cross-device email links cannot complete PKCE. Keep the same-browser assumption for now.
- `workspace_state.state` is JSONB and unbounded from the client's perspective. Enforce the 900 KB
  guard in `queueSave` and watch payload size.
- No test coverage exists. The manual matrix above is the release gate; do not claim test coverage
  that the repository does not have.
- Supabase project keys, CLI, and Docker are not available in this workspace yet, so end-to-end
  verification is blocked until provisioning is done.
- **Async boot flash.** The boot function awaits `getSession()` and `loadWorkspace()` (200-500 ms).
  Without a skeleton render before the first `await`, the user sees a blank screen or a brief flash
  of the login screen. A skeleton/busy state must render synchronously. See §5 `main.js` edits.
- **Realtime staleness window.** Between `loadWorkspace()` and `subscribeWorkspace()`, another
  device can write a new snapshot. The missed event is never replayed. The §3 mitigation (fetch
  latest state after subscribing) is mandatory, not optional — without it, the user can see stale
  data until the next change.
- **Import is a one-shot operation.** Import runs only when `loadWorkspace()` returns
  `needsWorkspace` and `gr8r.v2` exists. On a second device, `gr8r.v2` does not exist (or the
  remote workspace already does), so the import path is closed. Document this for users and provide
  a manual export/import script in Phase 2.
- **Optimistic save paints before confirmation.** `mutate()` calls `save()` then `render()`
  synchronously. `save()` is fire-and-forget in cloud mode, so a failed RPC leaves the UI showing
  data that does not exist on the server. The conflict toast and manual reload are the recovery
  path. Do not present the UI as accurate after a failed save until the next render cycle.

## 14. Definition of done

- Email/password signup, login, verification, password reset, password change, and sign-out work
  against Supabase.
- Existing `gr8r.v2` data imports once into a new workspace without duplicating on later logins.
- `S.data` hydrates from `workspace_state`, saves through `save_workspace_state`, and updates across
  devices through Realtime.
- Version conflicts and network failures are visible and recoverable; they never silently overwrite
  newer server data.
- RLS prevents cross-workspace reads/writes and direct state writes.
- The app still runs in local mode when Supabase env vars are absent.
- `npm run lint`, `npm run format:check`, and `npm run build` pass.
- No test files, test dependencies, or test CI jobs are added.
- No secret key is present in the client bundle or source tree.
- Realtime staleness is mitigated: after subscribing to `workspace_state` changes, the client always
  fetches the latest state once to close the subscribe/read race window.
