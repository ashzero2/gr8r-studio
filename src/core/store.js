/* ---------- store ---------- */
import { TODAY, diffD, iso, parse, uid } from './utils.js';
import { PCOLORS, TEAMS_SEED } from './constants.js';
import { seed } from '../data/seed.js';
import { queueSave, readCache } from './persistence.js';
import { supabaseEnabled } from './supabase.js';

export const STORE_KEY = 'gr8r.v2';
export const PREFS_KEY = 'gr8r.prefs';
export const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'indigo',
  side: 'comfortable',
  density: 'comfortable',
  weekStart: 1,
  dateFmt: 'MMM d',
  lang: 'English (US)',
  tz: '(GMT-07:00) Pacific Time',
  motion: 'system',
  home: 'home',
  openTasks: 'drawer',
  name: 'Tanjim Islam',
  title: 'Head of Product',
};
export function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && j.data && j.data.tasks) return j;
    }
  } catch {
    /* storage blocked or corrupt: start from seed data */
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage blocked or corrupt: start from seed data */
  }
  return null;
}
export const saved = load();
const cached = readCache();
export const S = {
  data: cached?.state || saved?.data || seed(),
  prefs: Object.assign({}, DEFAULT_PREFS, saved?.prefs || {}),
  views: saved?.views || {},
  ui: {
    fx: {},
    auth: null,
    authStep: 'login',
    onb: 0,
    onbData: { use: 'product', team: 'kanban', size: '2-10', ws: '', proj: 'Website Launch', tmpl: 'web', invites: '' },
    route: 'home',
    params: {},
    history: [],
    collapsed: !!saved?.collapsed,
    mnav: false,
    expanded: { p1: true },
    drawer: null,
    drawerFull: false,
    drawerTab: 'comments',
    modals: [],
    pop: null,
    palette: null,
    loading: false,
    offline: false,
    sel: new Set(),
    composer: null,
    editCell: null,
    openTasks: {},
    collapsedGroups: {},
    calDate: iso(TODAY),
    calMode: 'month',
    tlZoom: 'week',
    tlGroup: 'status',
    fileView: 'grid',
    projView: 'grid',
    homeTab: 'upcoming',
    inboxCat: 'all',
    inboxUnread: false,
    inboxSel: null,
    notifFilter: 'all',
    settings: 'appearance',
    searchQ: '',
    searchCat: 'all',
    myView: 'list',
    membersTab: 'members',
    collapsedCols: {},
    errors: {},
    drafts: {},
  },
};
export let _saveT;
export function save() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    const local = { prefs: S.prefs, views: S.views, collapsed: S.ui.collapsed };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(local));
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

/* Remote snapshot -> app state. The DB row is canonical for the workspace name/slug. */
export function hydrate(state, ws = {}) {
  if (state && Object.keys(state).length) S.data = state;

  if (ws.memberKey) {
    S.data.me = ws.memberKey;
    if (!S.data.members.some(m => m.id === ws.memberKey)) {
      S.data.members.push({
        id: ws.memberKey,
        name: S.prefs.name,
        email: '',
        role: 'Owner',
        team: null,
        title: '',
        c: '#6B7280',
        status: 'active',
        last: null,
        tz: '—',
      });
    }
  }

  if (ws.name) S.data.ws = Object.assign({}, S.data.ws, { name: ws.name, url: ws.slug || S.data.ws.url });
  if (ws.id) S.data.workspaces = [{ id: ws.id, name: S.data.ws.name, c: S.data.ws.c, plan: 'Free' }];

  const m = S.data.members.find(x => x.id === S.data.me);
  if (m) {
    if (m.name) S.prefs.name = m.name;
    if (m.title) S.prefs.title = m.title;
  }
}

/* ---------- lookups ---------- */
export const D = () => S.data;
export const me = () => D().members.find(m => m.id === D().me);
export const mem = id => D().members.find(m => m.id === id);
export const proj = id => D().projects.find(p => p.id === id);
export const task = id => D().tasks.find(t => t.id === id);
export const pColor = p => PCOLORS[p?.color] || PCOLORS.slate;
export const visibleProjects = () =>
  D()
    .projOrder.map(proj)
    .filter(Boolean)
    .filter(p => !p.archived);
export const canSee = p => !p.private || p.members.includes(D().me);
export const tasksOf = pid => D().tasks.filter(t => t.project === pid && !t.archived);
export const allTasks = () => D().tasks.filter(t => !t.archived && canSee(proj(t.project)));
export const isOver = t => t.due && t.status !== 'done' && diffD(parse(t.due), TODAY) < 0;
export const commentsOf = tid => D().comments.filter(c => c.task === tid);
export function progressOf(pid) {
  const ts = tasksOf(pid);
  if (!ts.length) return 0;
  return Math.round((ts.filter(t => t.status === 'done').length / ts.length) * 100);
}
export function taskProg(t) {
  if (t.status === 'done') return 100;
  if (t.subtasks.length) return Math.round((t.subtasks.filter(s => s.done).length / t.subtasks.length) * 100);
  return { backlog: 0, todo: 5, progress: 45, review: 80 }[t.status] || 0;
}

/* ---------- activity + notification helpers ---------- */
export function logAct(verb, t, extra = '') {
  D().activity.unshift({ id: uid('a'), by: D().me, verb, task: t?.id || null, project: t?.project || null, at: Date.now(), extra });
  if (t) t.updated = Date.now();
}

/* ---------- teams (workspace data, seeded on first use) ---------- */
export const NO_TEAM = { id: '', name: 'No team', icon: 'users', c: '#8A867E', desc: '' };
export function teamsList() {
  const d = D();
  if (!d.teams) d.teams = TEAMS_SEED.map(t => ({ ...t }));
  return d.teams;
}
export function team(id) {
  return teamsList().find(t => t.id === id) || null;
}
export const TM = new Proxy({}, { get: (_, k) => team(k) || NO_TEAM });
