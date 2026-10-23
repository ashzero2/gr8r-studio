/* ---------- supabase client ---------- */
import { createClient } from '@supabase/supabase-js';

const url = /* @vite-ignore */ import.meta.env.VITE_SUPABASE_URL;
const key = /* @vite-ignore */ import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

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
