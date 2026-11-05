// Prerendered at build time and precached by the service worker, which serves it for any
// navigation that fails (offline, server unreachable). It renders inside the app shell, so the
// tabs that need no server data keep working.
export const prerender = true;

export const load = () => ({ offlineScreen: true });
