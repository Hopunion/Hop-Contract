// Supabase publishable credentials are safe to use in browser code when RLS is enabled.
// Vercel environment variables override these defaults when present.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://xwelmyzeoykakvrazaaa.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_6FifNUNOYeT_iJanXo5CEw_2VHs9f0q';
