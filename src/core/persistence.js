/* ---------- persistence layer ----------
 * Single responsibility: Supabase session, workspace loading, versioned saves,
 * cache, and Realtime. Exports are used by store.js and main.js.
 *
 * When Supabase env vars are absent the module is a no-op stack, keeping the
 * existing localStorage behaviour in `src/core/store.js`.
 * ------------------------------------------------------------------------- */
import { supabase, supabaseEnabled } from './supabase.js';

/* ---------- cache ---------- */
const CACHE_KEY = 'gr8r.v3.cache';

let workspaceId = null;
let version = 0;
let pending = null;
let timer = null;
let inFlight = false;
let retries = 0;
let notifyFn = null;

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

export function clearCloudCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* best-effort */
  }
}

export function getWorkspaceId() {
  return workspaceId;
}

export function setSyncNotifier(fn) {
  notifyFn = fn;
}

/* ---------- session ---------- */
export async function getSession() {
  if (!supabaseEnabled) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/* ---------- workspace loading ---------- */
export async function loadWorkspace() {
  if (!supabaseEnabled) return { needsAuth: true };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { needsAuth: true };

  const { data: membership, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id, member_key, role')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
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

/* ---------- workspace creation ---------- */
export async function createWorkspace({ name, slug, memberKey, state }) {
  if (!supabaseEnabled) throw new Error('Supabase not configured');

  const { data: newId, error } = await supabase.rpc('create_workspace', {
    p_name: name,
    p_slug: slug,
    p_member_key: memberKey,
    p_state: state,
  });

  if (error) throw error;

  workspaceId = newId;
  version = 1;
  writeCache(state);

  return newId;
}

/* ---------- workspace meta update ---------- */
export async function saveWorkspaceMeta({ name, slug }) {
  if (!supabaseEnabled || !workspaceId) return;

  const { error } = await supabase
    .from('workspaces')
    .update({
      ...(name ? { name } : {}),
      ...(slug ? { slug } : {}),
    })
    .eq('id', workspaceId);

  if (error) throw error;
}

/* ---------- versioned snapshot save ---------- */
export function queueSave(state) {
  if (!supabaseEnabled || !workspaceId) return;
  pending = state;
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
}

export function flushSave() {
  return new Promise(resolve => {
    if (!inFlight && !pending) return resolve();
    const check = () => {
      if (!inFlight && !pending) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
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
    notifyFn && notifyFn({ status: 'saved', version });

    /* On first confirmed sync, remove the legacy key so local-back-and-forth
       does not produce two independent data copies. */
    if (localStorage.getItem('gr8r.v2')) {
      try {
        localStorage.removeItem('gr8r.v2');
      } catch {
        /* best-effort */
      }
    }

    if (pending) flush();
    return;
  }

  if (error.code === '40001') {
    /* version conflict: keep local snapshot so UI can retry or export */
    pending = state;
    notifyFn && notifyFn({ status: 'conflict' });
    window.dispatchEvent(new CustomEvent('gr8r:conflict'));
    return;
  }

  if (error.code === '42501' || error.code === 'PGRST301') {
    /* RLS or expired session: do not retry */
    notifyFn && notifyFn({ status: 'auth-error' });
    window.dispatchEvent(new CustomEvent('gr8r:auth-error'));
    return;
  }

  /* Network or temporary failure: retry with capped exponential backoff */
  const delay = Math.min(30000, 1000 * Math.pow(2, retries++));
  pending = pending || state;
  setTimeout(flush, delay);
  notifyFn && notifyFn({ status: 'retrying', delay });
}

export function retrySync() {
  if (pending) flush();
  else notifyFn && notifyFn({ status: 'idle' });
}

/* ---------- Realtime ---------- */
let _channel = null;

export function subscribeWorkspace(onState) {
  if (!supabaseEnabled || !workspaceId) return;

  _channel = supabase
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

  /* Realtime staleness mitigation: after subscribing, fetch the latest state
     once to close the subscribe/read race window (§3 of the implementation plan). */
  supabase
    .from('workspace_state')
    .select('state, version')
    .eq('workspace_id', workspaceId)
    .single()
    .then(({ data: row }) => {
      if (row) {
        const rv = Number(row.version);
        if (rv > version) {
          version = rv;
          writeCache(row.state);
          onState(row.state);
        }
      }
    })
    .catch(() => {
      /* best-effort */
    });
}

export function unsubscribeWorkspace() {
  if (_channel) {
    supabase.removeChannel(_channel);
    _channel = null;
  }
}
