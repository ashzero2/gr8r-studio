# Supabase + Vercel production playbook

Status: implementation guide for Gr8r Studio. Research current as of October 2026.

This document separates **Phase 1** (cross-device sync with minimal changes to the app) from
**Phase 2** (normalized multi-user data model). Read the security note in section 1 before choosing.

**Locked for this implementation:** snapshot-first, email/password only, one workspace per user,
import existing `gr8r.v2` data on first login, and no automated tests. The build sequence and
acceptance criteria live in [`supabase-implementation-plan.md`](./supabase-implementation-plan.md).

---

## 1. Architecture decision

### Phase 1: snapshot sync + real tenancy

```
Browser (Vite SPA on Vercel)
  ├── @supabase/supabase-js (publishable key)
  ├── Supabase Auth (PKCE)
  ├── PostgREST data API (RLS on every table)
  └── Supabase Realtime (RLS on workspace_state)
            │
            ▼
Supabase Postgres
  ├── workspaces
  ├── workspace_members   ← auth user ↔ workspace, role, member_key
  └── workspace_state     ← existing S.data JSON + version
```

Why this shape:

- The app renders synchronously from one `S.data` object (`src/core/store.js`). Keeping that shape
  avoids rewriting every page and view.
- The current state is about 31 KB (49 tasks, 7 projects, 8 members). Whole-snapshot writes are
  cheap at this scale.
- All writes already funnel through `save()` and `mutate()`, so there is one seam to replace.
- A `version` column gives optimistic concurrency, so a stale device cannot silently overwrite a
  newer snapshot.
- RLS on `workspace_members` and `workspace_state` gives real security without exposing a secret key.

**Important limitation:** a JSONB snapshot is workspace-level. Every member of a workspace can read
the entire snapshot, including projects marked `private`. If private projects, guest restrictions,
or per-project permissions are real requirements, skip to Phase 2 and normalize at least
`projects`, `project_members`, and `tasks` from the start.

Phase 1 is also **single-user per workspace out of the box**. `workspace_members` can hold multiple
users, but adding a second user needs an invite flow (Phase 2) or an admin script. Phase 1 is enough
for one person syncing across devices; it is not yet a multi-user product.

### Phase 2: normalized model

Normalize `members`, `projects`, `project_members`, `tasks`, `comments`, `notifications`, `files`,
`events`, `activity`, and `saved_views`. Use per-entity RLS, `deleted_at` tombstones, `updated_at`,
UUIDs, and entity-level Realtime patches. This is required for private projects, guest access, and
two people editing the same task concurrently.

---

## 2. Production principles (research summary)

These are the rules the rest of this document follows. Links are to the current Supabase docs.

1. **Use the new API key model.** Browser code gets a publishable key (`sb_publishable_...`).
   Server code gets a secret key (`sb_secret_...`). The legacy `anon` and `service_role` JWT keys are
   deprecated at the end of 2026. A secret key bypasses RLS and must never appear in a `VITE_*`
   variable, the bundle, or source control.
   [API keys](https://supabase.com/docs/guides/getting-started/api-keys)

2. **RLS is the security boundary, not the key.** Enable RLS on every exposed table, grant only to
   `authenticated`, and add policies. Wrap `auth.uid()` in `(select auth.uid())`, put `TO authenticated`
   on every policy, and index columns used in policies. Use `security definer` helpers in a private
   schema with `set search_path = ''` for cross-table checks.
   [RLS performance](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv),
   [Securing your API](https://supabase.com/docs/guides/api/securing-your-api)

3. **Schema changes go through migrations.** Develop locally with the Supabase CLI, commit
   `supabase/migrations/*.sql`, and deploy with `supabase db push` from CI. Do not make hand edits in
   the production dashboard. Use separate staging and production projects.
   [Managing environments](https://supabase.com/docs/guides/deployment/managing-environments)

4. **Use PKCE auth.** The app uses hash routing (`location.hash`). The implicit flow puts tokens in
   the hash and would confuse the router; PKCE returns a `?code=` query parameter and `supabase-js`
   exchanges it automatically. Boot must await the session before rendering the auth screen.
   [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)

5. **Configure Vercel redirect URLs.** Add the production domain, `http://localhost:5173/**`, and
   the preview wildcard `https://*-<team-or-account-slug>.vercel.app/**` to Supabase Auth. Set the
   Site URL to the production domain. Use a custom SMTP provider before launch; the default email
   sender is rate-limited and not suitable for production.
   [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls),
   [Production checklist](https://supabase.com/docs/guides/platform/going-into-prod)

6. **Vercel Marketplace caveat.** The Supabase/Vercel integration syncs `NEXT_PUBLIC_*` and
   `SUPABASE_*` variables, not `VITE_*`. For a Vite app, add `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` manually in Vercel for Production, Preview, and Development.
   [Vercel Marketplace](https://supabase.com/docs/guides/integrations/vercel-marketplace)

7. **Realtime respects RLS.** Postgres Changes only sends rows the subscriber can read. Add the table
   to the `supabase_realtime` publication and subscribe once per workspace. For larger payloads or
   scale, switch to Broadcast from the database rather than sending the whole row.
   [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization)

8. **Production is more than a database.** Use Supabase Pro for no idle pausing and backups/PITR,
   enable SSL enforcement, protect the Supabase account with MFA, run the Security and Performance
   Advisors, configure custom SMTP, and test restoring a backup.
   [Production checklist](https://supabase.com/docs/guides/platform/going-into-prod)

---

## 3. Step-by-step setup

### Step 0 — Create the projects

1. Create a Supabase organization and enable MFA on the account.
2. Create two projects in the same region as most users:
   - `gr8r-staging`
   - `gr8r-prod`
3. Store the project refs and database passwords in a password manager.
4. Do not point local development at production.

### Step 1 — Install the CLI and client

```bash
# macOS
brew install supabase/tap/supabase

# from the repo
npm install @supabase/supabase-js
supabase login
supabase init
supabase link --project-ref <staging-project-ref>
```

Local schema work also needs Docker Desktop (or another container runtime).

### Step 2 — Environment variables

Commit `.env.example` (never real keys):

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
```

Create `.env.local` (already ignored by `.env*`) with the staging values:

```dotenv
VITE_SUPABASE_URL=https://<staging-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Vite inlines `VITE_*` values into the client bundle at build time. Treat them as public. Changing
them requires a redeploy. Never create a `VITE_` variable containing `sb_secret_...`.

In Vercel, add both variables for:

| Vercel environment | Supabase project                 |
| ------------------ | -------------------------------- |
| Production         | `gr8r-prod`                      |
| Preview            | `gr8r-staging`                   |
| Development        | `gr8r-staging` or local Supabase |

If you install the Vercel Marketplace integration, it creates `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_*` aliases. They do not replace `VITE_*` for Vite; add
the Vite names manually. Mark the publishable key as a normal config value (it is public). If the
integration creates `SUPABASE_SECRET_KEY`, mark it as a Secret and never reference it from `src/`.

### Step 3 — Configure Auth

In Supabase Dashboard → Authentication → URL Configuration:

- **Site URL:** `https://your-production-domain.com`
- **Redirect URLs:**
  - `http://localhost:5173/**`
  - `https://your-production-domain.com/**`
  - `https://*-<team-or-account-slug>.vercel.app/**`

In Authentication → Providers:

- Enable Email and turn on **Confirm email**. Email/password is the only provider for Phase 1.
- Leave Google, Microsoft, Apple, and other social providers disabled. Do not render social buttons
  that cannot complete a sign-in.
- Set OTP expiry to one hour or less.
- Enable **Require current password when changing password** so the settings form can use
  `updateUser({ email, current_password, password })`.

In Authentication → Emails:

- Configure custom SMTP (Resend, SES, Postmark, etc.) before inviting real users.
- Update the confirmation and recovery templates only if you change the token flow. The default
  `{{ .ConfirmationURL }}` works with PKCE on the same device.

In Authentication → Rate Limits / Attack Protection:

- Enable CAPTCHA (Turnstile or hCaptcha) before a public launch.
- Review signup, OTP, and token-refresh limits.

**PKCE caveat:** the code verifier is stored in the browser that started the flow. If a user opens a
confirmation or recovery email on a different device, PKCE cannot complete. If cross-device email
links are required, use the token-hash template and `supabase.auth.verifyOtp({ token_hash, type })`
instead.

**Cross-device email link mitigation.** If recovery or confirmation links opened on a second device
are a supported scenario, switch the Supabase Auth email templates from the default `ConfirmationURL`
variable to `TokenHash`. The modified template URL pattern is:

```
{{ .SiteURL }}/?type={{ .TokenType }}&token_hash={{ .TokenHash }}
```

Then in `src/main.js`, detect `token_hash` in the query string during boot:

```js
const params = new URLSearchParams(window.location.search);
const tokenHash = params.get('token_hash');
const type = params.get('type'); // 'signup' or 'recovery'

if (tokenHash && type) {
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (!error) {
    window.history.replaceState({}, '', window.location.origin);
    // Proceed: session is now set
  }
}
```

This moves the PKCE assumption from "same browser" to "client-side token exchange" and works on any
device. The code verifier is never stored; the token hash serves the same purpose. Document this
choice in the email-templates checklist and keep both approaches in the redirect URL allowlist.

### Step 4 — Phase 1 schema

Create the migration:

```bash
supabase migration new init
```

Paste this into `supabase/migrations/<timestamp>_init.sql`:

```sql
-- Phase 1: tenancy + workspace snapshot.
-- The snapshot is the existing S.data object; members are the app's display data.
-- workspace_members is the auth/RLS gate and maps a user to S.data.me via member_key.

create extension if not exists pgcrypto;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62})$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_key text not null check (char_length(member_key) between 1 and 64),
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'guest')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  unique (workspace_id, member_key)
);

create index workspace_members_user_id_idx
  on public.workspace_members (user_id);

create table public.workspace_state (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- Private helper schema. Not exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = (select auth.uid())
  );
$$;

create or replace function private.workspace_role(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = (select auth.uid())
  limit 1;
$$;

create or replace function private.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.workspace_role(p_workspace_id) in ('owner', 'admin'), false);
$$;

revoke all on function private.is_workspace_member(uuid) from public;
revoke all on function private.workspace_role(uuid) from public;
revoke all on function private.is_workspace_admin(uuid) from public;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.workspace_role(uuid) to authenticated;
grant execute on function private.is_workspace_admin(uuid) to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_state enable row level security;

create policy "workspaces_select_member"
on public.workspaces for select to authenticated
using ((select private.is_workspace_member(id)));

create policy "workspaces_update_admin"
on public.workspaces for update to authenticated
using ((select private.is_workspace_admin(id)))
with check ((select private.is_workspace_admin(id)));

create policy "workspace_members_select_member"
on public.workspace_members for select to authenticated
using ((select private.is_workspace_member(workspace_id)));

create policy "workspace_state_select_member"
on public.workspace_state for select to authenticated
using ((select private.is_workspace_member(workspace_id)));

revoke all on table public.workspaces from anon;
revoke all on table public.workspace_members from anon;
revoke all on table public.workspace_state from anon;
revoke all on table public.workspaces from authenticated;
revoke all on table public.workspace_members from authenticated;
revoke all on table public.workspace_state from authenticated;

grant select on table public.workspaces to authenticated;
grant select on table public.workspace_members to authenticated;
grant select on table public.workspace_state to authenticated;
grant update (name, slug) on table public.workspaces to authenticated;

create or replace function public.create_workspace(
  p_name text,
  p_slug text,
  p_member_key text,
  p_state jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_workspace_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'workspace name is required';
  end if;

  if p_member_key is null or char_length(trim(p_member_key)) = 0 then
    raise exception 'member key is required';
  end if;

  insert into public.workspaces (name, slug, created_by)
  values (trim(p_name), lower(trim(p_slug)), v_user_id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, member_key, role)
  values (v_workspace_id, v_user_id, trim(p_member_key), 'owner');

  insert into public.workspace_state (workspace_id, state, version, updated_by)
  values (
    v_workspace_id,
    coalesce(p_state, '{}'::jsonb),
    1,
    v_user_id
  );

  return v_workspace_id;
end;
$$;

revoke all on function public.create_workspace(text, text, text, jsonb) from public;
grant execute on function public.create_workspace(text, text, text, jsonb) to authenticated;

create or replace function public.save_workspace_state(
  p_workspace_id uuid,
  p_expected_version bigint,
  p_state jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'not a workspace member' using errcode = '42501';
  end if;

  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'state must be a JSON object';
  end if;

  update public.workspace_state
     set state = p_state,
         version = version + 1,
         updated_at = now(),
         updated_by = (select auth.uid())
   where workspace_id = p_workspace_id
     and version = p_expected_version
  returning version into v_version;

  if v_version is null then
    raise exception 'workspace version conflict' using errcode = '40001';
  end if;

  return v_version;
end;
$$;

revoke all on function public.save_workspace_state(uuid, bigint, jsonb) from public;
grant execute on function public.save_workspace_state(uuid, bigint, jsonb) to authenticated;

create or replace function public.set_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_role text;
  v_owner_count integer;
begin
  if not private.is_workspace_admin(p_workspace_id) then
    raise exception 'not a workspace admin' using errcode = '42501';
  end if;

  if (p_role is null or p_role not in ('owner', 'admin', 'member', 'guest')) then
    raise exception 'invalid role';
  end if;

  select role into v_current_role
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;

  if v_current_role is null then
    raise exception 'member not found';
  end if;

  if v_current_role = 'owner' and p_role <> 'owner' then
    select count(*) into v_owner_count
    from public.workspace_members
    where workspace_id = p_workspace_id and role = 'owner';

    if v_owner_count <= 1 then
      raise exception 'workspace must have at least one owner';
    end if;
  end if;

  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id;
end;
$$;

revoke all on function public.set_member_role(uuid, uuid, text) from public;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function private.set_updated_at();

create trigger workspace_members_set_updated_at
before update on public.workspace_members
for each row execute function private.set_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_state'
  ) then
    execute 'alter publication supabase_realtime add table public.workspace_state';
  end if;
end $$;
```

**Phase 1 scope: file attachments stay metadata-only.** The snapshot already stores file metadata
(name, size, type, project association). In Phase 1 these remain embedded in the JSONB snapshot,
which works for the current ~31 KB payload. Real file uploads (Supabase Storage with signed URLs,
upload tokens, and progress callbacks) are Phase 2. If the snapshot regularly exceeds 900 KB due to
file metadata, push file storage earlier.

Apply and verify locally:

```bash
supabase start
supabase db reset
supabase db lint --local --level warning
supabase db diff --strict-coverage
```

Then push to staging:

```bash
supabase link --project-ref <staging-ref>
supabase db push
```

### Step 5 — What the RLS rules guarantee

- `anon` has no table grants and cannot read anything.
- A signed-in user can read only workspaces where a `workspace_members` row matches their
  `auth.uid()`.
- `workspace_state` is read-only through the Data API. Writes must go through
  `save_workspace_state`, which checks membership and the expected version.
- A workspace admin can rename the workspace and change roles through `set_member_role`; a regular
  member cannot.
- The last owner cannot be demoted.
- `security definer` helpers are schema-qualified and have `search_path = ''`, so they cannot be
  hijacked by a malicious schema.

Run the Security Advisor after applying:

Dashboard → Advisors → Security. Resolve every critical/high finding before launch.

### Step 6 — Add the Supabase client

`src/core/supabase.js`:

```js
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabaseEnabled = Boolean(url && key);

export const supabase = supabaseEnabled
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
      global: { headers: { 'x-application-name': 'gr8r-studio' } },
    })
  : null;
```

Guarding on the env vars means the app still runs on localStorage until you add keys. Do not import
this module from any server-only code that needs a secret key.

### Step 7 — Replace the persistence seam

Add `src/core/persistence.js` with four responsibilities: cache, hydrate, versioned save, subscribe.

```js
import { supabase } from './supabase.js';

const CACHE_KEY = 'gr8r.v3.cache';

let workspaceId = null;
let version = 0;
let pending = null;
let timer = null;
let inFlight = false;
let retries = 0;

export function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeCache(state) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ state, at: Date.now() }));
  } catch {
    /* quota or blocked storage: cache is optional */
  }
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function loadWorkspace() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { needsAuth: true };

  const { data: membership, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id, member_key, role')
    .eq('user_id', user.id)
    .order('created_at')
    .limit(1)
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return { needsWorkspace: true, user };

  const [{ data: workspace, error: wsError }, { data: row, error: stateError }] = await Promise.all([
    supabase.from('workspaces').select('id, name, slug').eq('id', membership.workspace_id).single(),
    supabase.from('workspace_state').select('state, version').eq('workspace_id', membership.workspace_id).single(),
  ]);

  if (wsError) throw wsError;
  if (stateError) throw stateError;

  workspaceId = membership.workspace_id;
  version = Number(row.version);
  writeCache(row.state);

  return { workspace, membership, state: row.state, version };
}

export function queueSave(state) {
  if (!workspaceId) return;
  pending = state;
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
}

async function flush() {
  if (!pending || inFlight) return;
  inFlight = true;

  const state = pending;
  pending = null;
  const expected = version;

  const { data, error } = await supabase.rpc('save_workspace_state', {
    p_workspace_id: workspaceId,
    p_expected_version: expected,
    p_state: state,
  });

  inFlight = false;

  if (!error) {
    version = Number(data);
    retries = 0;
    writeCache(state);
    if (pending) flush();
    return;
  }

  if (error.code === '40001') {
    // Keep the local snapshot so the UI can retry or export it.
    pending = state;
    window.dispatchEvent(new CustomEvent('gr8r:conflict'));
    return;
  }

  if (error.code === '42501' || error.code === 'PGRST301') {
    // RLS or expired session: do not retry forever.
    window.dispatchEvent(new CustomEvent('gr8r:auth-error'));
    return;
  }

  // Network or temporary failure: retry with exponential backoff.
  pending = pending || state;
  setTimeout(flush, Math.min(30000, 1000 * 2 ** retries++));
}

export function subscribeWorkspace(onState) {
  return supabase
    .channel(`workspace:${workspaceId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'workspace_state',
        filter: `workspace_id=eq.${workspaceId}`,
      },
      payload => {
        const remoteVersion = Number(payload.new.version);
        if (remoteVersion > version && !pending) {
          version = remoteVersion;
          writeCache(payload.new.state);
          onState(payload.new.state);
        }
      },
    )
    .subscribe();
}
```

Update `src/core/store.js` (keep the existing `load()` / `saved` code as the local fallback):

```js
import { readCache, queueSave } from './persistence.js';
import { supabaseEnabled } from './supabase.js';

const saved = load(); // existing gr8r.v2 loader
const cached = readCache();

export const S = {
  data: cached?.state || saved?.data || seed(),
  prefs: Object.assign({}, DEFAULT_PREFS, saved?.prefs || {}),
  views: saved?.views || {},
  // ...existing ui...
};

export function save() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    const local = { prefs: S.prefs, views: S.views, collapsed: S.ui.collapsed };
    try {
      localStorage.setItem('gr8r.prefs', JSON.stringify(local));
    } catch {
      /* storage blocked: prefs stay in memory */
    }

    if (supabaseEnabled) {
      queueSave(S.data);
      return;
    }

    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ data: S.data, ...local }));
    } catch {
      /* storage full or blocked: keep working in memory */
    }
  }, 150);
}
```

On first login, if the remote `workspace_state` is empty and `saved?.data` exists, use that as the
onboarding initial state. This is the one-time migration from `gr8r.v2` to Supabase. After that,
`gr8r.v2` is only a fallback for local development without env vars.

Keep `prefs`, `views`, `recentSearches`, and per-user notification read state out of the shared
snapshot in Phase 2. For Phase 1, the snapshot is a single-user/trusted-team model.

### Step 8 — Boot and auth

`src/main.js` becomes async and waits for Supabase before the first real render:

```js
import { supabaseEnabled } from './core/supabase.js';
import { getSession, loadWorkspace, subscribeWorkspace } from './core/persistence.js';

async function boot() {
  if (supabaseEnabled) {
    try {
      const session = await getSession();
      if (!session) {
        S.ui.auth = 'login';
        render();
        return;
      }

      const ws = await loadWorkspace();

      if (ws.needsWorkspace) {
        S.ui.auth = 'onboarding';
        render();
        return;
      }

      if (ws.state && Object.keys(ws.state).length) {
        S.data = ws.state;
        S.data.me = ws.membership.member_key;
        S.data.ws = { name: ws.workspace.name, url: ws.workspace.slug, c: '#1D1C1A' };
      }

      subscribeWorkspace(state => {
        S.data = state;
        render();
      });
    } catch (err) {
      // Render the cached snapshot instead of a blank screen. Phase 1 is online-first;
      // writes made while offline are not queued across tabs yet.
      console.error('[boot] Supabase hydration failed', err);
      S.ui.offline = true;
    }
  }

  render();
}

boot();
```

Wire the existing auth screens to Supabase. Keep the same `S.ui.auth` states so the design does not
change:

**Skeleton rendering during async boot.** The boot function awaits `getSession()` and
`loadWorkspace()`, which may take 200-500 ms. During that time the page must render something. Add a
loading state before any `await`:

```js
// In main.js, before any Supabase call:
if (supabaseEnabled) {
  S.ui.auth = 'loading';   // a centered spinner or skeleton
  render();                 // paint immediately
  // ...then await getSession()...
}
```

The `auth = 'loading'` state shows a spinner or skeleton. If the state does not exist in
`src/pages/auth.js`, add a minimal template. This prevents a flash-of-unauthenticated-content where
the login screen appears before Supabase responds. Once the session resolves, the real screen
replaces the skeleton.

```js
A.doLogin = async () => {
  const email = $('#l-email').value.trim();
  const password = $('#l-pw').value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    S.ui.errors = { login: error.message };
    render();
    return;
  }
  await enterApp();
};

A.doSignup = async () => {
  const name = $('#s-name').value.trim();
  const email = $('#s-email').value.trim();
  const password = $('#s-pw').value;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name },
      emailRedirectTo: window.location.origin,
    },
  });

  if (error) {
    S.ui.errors = { email: error.message };
    render();
    return;
  }

  if (data.session) {
    await enterApp('Account created');
  } else {
    S.ui.auth = 'verify';
    render();
  }
};

A.doForgot = async () => {
  const email = $('#f-email').value.trim();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/?type=recovery`,
  });
  S.ui.auth = 'forgot-sent';
  render();
};

A.doReset = async () => {
  const password = $('#r-pw').value;
  const { error } = await supabase.auth.updateUser({ password });
  S.ui.auth = error ? 'reset' : 'reset-done';
  render();
};

A.signOut = async () => {
  await supabase.auth.signOut();
  // Reloading also tears down the old Realtime channel and cached in-memory state.
  window.location.hash = '';
  window.location.reload();
};

A.socialAuth = () => {
  toast('Social sign-in is not enabled yet', { kind: 'info' });
};
```

Hydrate after login as well, not only on a full page load. `enterApp` should load the workspace
before navigating:

```js
export async function enterApp(msg) {
  const ws = await loadWorkspace();

  if (ws.needsWorkspace) {
    S.ui.auth = 'onboarding';
    render();
    return;
  }

  if (ws.state) {
    S.data = ws.state;
    S.data.me = ws.membership.member_key;
    S.data.ws = { name: ws.workspace.name, url: ws.workspace.slug, c: '#1D1C1A' };
  }

  S.ui.auth = null;
  S.ui.errors = {};
  go(S.prefs.home || 'home');
  toast(msg);
}
```

Subscribe to auth events once, after creating the client:

```js
supabase.auth.onAuthStateChange(event => {
  // Do not await Supabase calls inside this callback; defer to the next tick.
  setTimeout(() => {
    if (event === 'SIGNED_OUT') {
      S.ui.auth = 'login';
      render();
    }
    if (event === 'PASSWORD_RECOVERY') {
      S.ui.auth = 'reset';
      render();
    }
  }, 0);
});
```

**Hash-router note:** with `flowType: 'pkce'`, the callback URL is `/?code=...`, not
`/#access_token=...`. `detectSessionInUrl` exchanges the code, and `location.hash` stays clean for
the existing router. Await `getSession()` before rendering, or a signed-in user will briefly see the
login screen.

### Step 9 — Onboarding and import

On the final onboarding step, create the workspace and pass the current seed/local state:

```js
const memberKey = S.data.me || seed().me;
const initialState = { ...S.data, me: memberKey };

const { data: workspaceId, error } = await supabase.rpc('create_workspace', {
  p_name: S.ui.onbData.ws.trim(),
  p_slug: S.ui.onbData.url || 'workspace',
  p_member_key: memberKey,
  p_state: initialState,
});

if (error?.code === '23505') {
  S.ui.errors.ws = 'That workspace URL is already taken';
  render();
  return;
}
```

This preserves the existing seed data, including the demo members. They remain placeholder rows in
the snapshot; only the signed-in user is linked to `workspace_members`. Phase 2 turns them into real
members with invites.

If the browser already has `gr8r.v2` data and the user has no remote membership, skip onboarding and
import that snapshot with the same RPC. Set `S.data.me` to the imported member id (normally `m1`),
replace that member's name/email with the auth user's, retry the slug with a short suffix on `23505`,
then remove `gr8r.v2` so the snapshot cannot be imported into another account. See
`supabase-implementation-plan.md` §7 for the full sequence.

### Step 10 — Vercel configuration

`vercel.json` should keep the Vite build and add baseline security headers:

```json
{
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" }
      ]
    }
  ]
}
```

Add a CSP in **Report-Only** mode first, because the app uses inline `style` attributes:

```
default-src 'self';
connect-src 'self' https://*.supabase.co wss://*.supabase.co;
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
script-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

Watch the browser console for violations for a week, then switch to `Content-Security-Policy`.

The app uses hash routing, so no SPA catch-all rewrite is required. Add one only if you move to
history routing.

### Step 11 — CI/CD for migrations

Keep the existing lint/format/build CI. Add a schema job and deploys.

`.github/workflows/ci.yml` — add:

```yaml
supabase:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: supabase/setup-cli@v1
      with:
        version: latest
    - run: supabase db start
    - run: supabase db lint --local --level warning --fail-on warning
    - run: supabase db diff --strict-coverage
```

This is schema validation, not an application test suite. The repo has no test runner, so the plan
does not add a test job.

`.github/workflows/supabase-production.yml`:

```yaml
name: Deploy migrations to production

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    env:
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
      SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase link --project-ref "$SUPABASE_PROJECT_ID"
      - run: supabase db push
```

Create a `develop` branch and a staging workflow with the staging secrets. Protect the production
GitHub Environment with required reviewers. Use a scoped Supabase access token, not a personal token
with organization-wide access.

### Step 12 — Production checklist

Before launch:

- [ ] Separate staging and production Supabase projects.
- [ ] All schema changes in `supabase/migrations`; no production dashboard edits.
- [ ] RLS enabled on every table; Security Advisor has no critical/high findings.
- [ ] Two-user RLS test: user A cannot read or write workspace B; member cannot escalate their role.
- [ ] Email confirmation enabled; custom SMTP configured; CAPTCHA enabled.
- [ ] Site URL and Vercel preview redirect URLs configured.
- [ ] `VITE_*` variables contain only the URL and publishable key.
- [ ] `SUPABASE_SECRET_KEY` exists only in server-side environments, if used at all.
- [ ] Supabase account MFA enabled; database password stored in a password manager.
- [ ] SSL enforcement enabled.
- [ ] Pro plan for no idle pausing; daily backups and PITR as needed.
- [ ] Restore a backup into staging and verify the app boots.
- [ ] Vercel env vars scoped to Production/Preview/Development; redeploy after changes.
- [ ] CSP in report-only mode, then enforced.
- [ ] Logs reviewed: Supabase Auth/API/Realtime/Postgres, Vercel build/runtime.
- [ ] Rate limits and abuse protection reviewed.
- [ ] `npm audit` clean.
- [ ] CSP `connect-src` includes `https://*.supabase.co` and `wss://*.supabase.co` for Realtime.
- [ ] Email template URLs use either `ConfirmationURL` (same-device PKCE) or `TokenHash` (cross-device) and the corresponding client code is implemented.
- [ ] Supabase Dashboard → Logs reviewed: Auth, API, Realtime, Postgres — no persistent errors or rate-limit warnings.
- [ ] Staging restore test: create a backup, restore to a staging project, verify the app boots and the user can sign in.
- [ ] Rate limits reviewed in Supabase Dashboard → Authentication → Rate Limits / Attack Protection; CAPTCHA enabled.

### Step 13 — Phase 2: normalize when you need real multi-user behavior

Phase 1 is enough for one user across devices, or a small trusted team. Normalize when you need any
of these:

- Private projects enforced by the database.
- Guest access limited to specific projects.
- Two people editing the same task without last-write-wins.
- Per-user notifications and read state.
- Reporting/filtering that should happen in SQL instead of JS.

Target tables:

```
members(id, workspace_id, user_id, name, email, role, status, title, color, timezone, ...)
workspace_invites(id, workspace_id, email, role, token_hash, expires_at, invited_by, accepted_at)
projects(id, workspace_id, key, name, status, team_id, lead_id, is_private, ...)
project_members(project_id, member_id)
tasks(id, workspace_id, project_id, key, title, status, assignee_id, priority,
      start_date, due_date, estimate, position, completed_at, created_at, updated_at, deleted_at)
subtasks(id, task_id, title, done, position)
task_labels(task_id, label)
task_dependencies(task_id, depends_on_task_id)
comments(id, task_id, author_id, body, created_at, updated_at, deleted_at)
comment_reactions(comment_id, member_id, emoji)
files(id, workspace_id, project_id, task_id, name, mime_type, size_bytes, storage_bucket, storage_path, uploaded_by, created_at, deleted_at)
  → Supabase Storage in a private bucket. Uploads use a server-side or Edge Function–generated
    upload token with a short expiry. The client never holds a Storage API key.
notifications(id, workspace_id, user_id, type, actor_id, task_id, read_at, created_at)
activity(id, workspace_id, actor_id, verb, task_id, project_id, metadata jsonb, created_at)
events(id, workspace_id, project_id, title, starts_at, ends_at, created_by)
saved_views(id, workspace_id, project_id, name, type, filters jsonb, created_by)
teams(id, workspace_id, name, icon, color, description)
```

Add `deleted_at` to every user-facing entity, `updated_at` triggers, indexes on every FK and RLS
column, and entity-level Realtime. This is the point where the per-project `canSee` check moves from
`src/core/store.js` into RLS policies.

---

## 4. Locked decisions

1. **Snapshot first.** Keep `S.data` in JSONB for Phase 1. Normalize when private projects, guests,
   or concurrent entity editing become real requirements.
2. **Email/password only.** Social providers stay disabled until the email flow is live and tested.
   Do not render social buttons that cannot sign a user in.
3. **Import on first login.** If `gr8r.v2` exists and the user has no remote membership, import it
   once. New users without local data start from onboarding and the seed template.
4. **Invites are Phase 2.** Supabase Auth admin invites require a server-side function or Edge
   Function. Phase 1 is single-user per workspace; do not show fake "invite sent" states.
5. **No application tests.** The repo has no test runner or test files. Keep CI at lint, format
   check, and build; use the manual matrix in the implementation plan as the release gate.
