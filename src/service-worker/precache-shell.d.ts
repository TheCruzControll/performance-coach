/**
 * The build files the worker precaches (`_app/immutable/…`, as `$app/manifest` names them): what
 * the shell, the workout pages and /offline need offline (scripts/lib/precache-scope.ts). The
 * precache-shell plugin in vite.config.ts writes it once the client build exists; in `vite dev`
 * (no build files) it is empty.
 */
declare module 'virtual:precache-shell' {
	export const shell: readonly string[];
}
