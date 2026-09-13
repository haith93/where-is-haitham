/**
 * Copy this file to `js/env.js` and fill in your own project values.
 *
 * `js/env.js` is git-ignored. On GitHub Pages it is generated at deploy
 * time by .github/workflows/deploy.yml from repository secrets, so you
 * never have to commit it.
 *
 * IMPORTANT
 * ---------
 * Only ever put the **anon / publishable** key here. It is designed to be
 * visible in a browser and every table is protected by Row Level Security.
 * The service-role key must NEVER appear anywhere in this folder.
 */
export const ENV = {
  // Supabase -> Project Settings -> API -> Project URL
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',

  // Supabase -> Project Settings -> API -> Project API keys -> anon public
  supabaseAnonKey: 'YOUR-ANON-PUBLIC-KEY',

  // Optional. Only needed for Web Push notifications.
  // Generate a VAPID key pair (see README) and paste the PUBLIC half here.
  // Leave empty to run without push; in-app realtime alerts still work.
  vapidPublicKey: ''
};
