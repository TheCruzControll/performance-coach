// The other-session workout (the M4 plan's decisions 5 and 6): prerendered like /workout, so its
// HTML is the same data-free shell for everyone, which the service worker precaches and serves
// offline. The session itself comes from IndexedDB in the browser; there is no load. Public, like
// /workout: a static file never reaches the guard, and vercel.json sends its security headers.
export const prerender = true;
