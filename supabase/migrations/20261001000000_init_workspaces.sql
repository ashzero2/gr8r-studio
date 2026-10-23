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