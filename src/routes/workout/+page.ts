// The strength workout and the place a workout starts (the M4 plan's decisions 5 and 6):
// prerendered, so its HTML is the same data-free shell for everyone, which the service worker
// precaches and serves offline whatever the query string. The workout itself comes from
// IndexedDB in the browser; there is no load. Public, like /offline: a static file never reaches
// the guard, and vercel.json sends its security headers.
export const prerender = true;
