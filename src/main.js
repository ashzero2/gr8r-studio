/* =====================================================================
   ENTRY: styles, then every module in dependency order (several register
   global listeners or add handlers to the action table when they load), then boot.
   ===================================================================== */
import './styles/index.css';
import './core/utils.js';
import './core/icons.js';
import './core/constants.js';
import './data/seed.js';
import './core/store.js';
import './ui/helpers.js';
import './core/theme.js';
import './ui/toast.js';
import './ui/select.js';
import './shell/render.js';
import './shell/layout.js';
import './shell/skeletons.js';
import './shell/view-engine.js';
import './components/task-list.js';
import './pages/home.js';
import './pages/overview.js';
import './pages/my-tasks.js';
import './pages/tasks.js';
import './pages/inbox.js';
import './pages/notifications.js';
import './pages/favorites.js';
import './pages/projects.js';
import './pages/members.js';
import './pages/activity.js';
import './pages/search.js';
import './pages/errors.js';
import './pages/project.js';
import './views/project-overview.js';
import './views/board.js';
import './views/table.js';
import './views/calendar.js';
import './views/timeline.js';
import './views/files.js';
import './overlays/drawer.js';
import './overlays/modals.js';
import './overlays/popovers.js';
import './overlays/context-menu.js';
import './overlays/palette.js';
import './pages/settings.js';
import './pages/auth.js';
import './pages/design-system.js';
import './actions/actions.js';
import './actions/events.js';
import './actions/keyboard.js';
import './actions/drag-drop.js';
import './features/teams.js';
import './features/subtasks.js';
import './features/archive.js';
import './actions/teams.js';
import './actions/subtasks.js';
import './actions/archive.js';
import { S, D } from './core/store.js';
import { A, openWorkspace } from './actions/actions.js';
import { flushSave, getSession, setSyncNotifier } from './core/persistence.js';
import { supabase, supabaseEnabled } from './core/supabase.js';
import { ROUTE_NAMES, render, go } from './shell/render.js';
import { toast } from './ui/toast.js';

const AUTH_ROUTES = ['login', 'signup', 'forgot', 'reset', 'verify', 'onboarding'];

function routeFromHash() {
  const h = (location.hash || '').slice(1);
  if (AUTH_ROUTES.includes(h)) S.ui.auth = h;
  else if (h && ROUTE_NAMES[h]) S.ui.route = h;
  else S.ui.route = S.prefs.home || 'home';
}

function handleAuthEvent(event) {
  if (event === 'PASSWORD_RECOVERY') {
    S.ui.auth = 'reset';
    render();
  } else if (event === 'SIGNED_OUT' && S.ui.auth !== 'reset-done') {
    S.ui.auth = 'login';
    render();
  }
}

function handleSync(s) {
  if (s.status === 'retrying') {
    S.ui.offline = true;
    render();
    return;
  }
  if (s.status === 'saved' || s.status === 'idle') {
    if (S.ui.offline) {
      S.ui.offline = false;
      render();
    }
    return;
  }
  if (s.status === 'conflict') {
    toast('This workspace changed on another device. Reload to load the latest version.', {
      kind: 'err',
      action: 'Reload',
      onAction: () => location.reload(),
      ms: 12000,
    });
    return;
  }
  if (s.status === 'auth-error') {
    toast('Your session expired. Please sign in again.', { kind: 'err' });
    S.ui.auth = 'login';
    render();
    return;
  }
  if (s.status === 'too-large') toast('This workspace is too large to sync. Remove large attachments and try again.', { kind: 'err', ms: 8000 });
}

async function boot() {
  document.documentElement.lang = 'en';
  if (!document.getElementById('sr-live')) {
    const l = document.createElement('div');
    l.id = 'sr-live';
    l.className = 'sr';
    l.setAttribute('aria-live', 'polite');
    document.body.appendChild(l);
  }

  if (!supabaseEnabled) {
    routeFromHash();
    render();
    return;
  }

  S.ui.auth = 'loading';
  render();
  setSyncNotifier(handleSync);
  supabase.auth.onAuthStateChange(event => setTimeout(() => handleAuthEvent(event), 0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  try {
    const session = await getSession();

    if (!session) {
      const h = (location.hash || '').slice(1);
      const pending = sessionStorage.getItem('gr8r.pendingEmail');
      if (h === 'verify' && pending) {
        S.ui.af = Object.assign(S.ui.af || {}, { email: pending });
        S.ui.auth = 'verify';
      } else S.ui.auth = h === 'signup' || h === 'forgot' ? h : 'login';
      render();
      return;
    }

    if (new URLSearchParams(location.search).get('type') === 'recovery') {
      S.ui.af = Object.assign(S.ui.af || {}, { email: session.user.email });
      S.ui.auth = 'reset';
      render();
      return;
    }

    await openWorkspace(session);
  } catch (err) {
    console.error('[boot] Supabase hydration failed', err);
    S.ui.offline = true;
    S.ui.auth = null;
    render();
    toast("Couldn't reach your workspace. Showing the last saved copy.", { kind: 'err', ms: 6000 });
  }
}

boot();

// Dev-only handle for debugging and screenshot tooling; stripped from production builds.
if (import.meta.env.DEV) window.__gr8r = { S, D, A, go, render };
