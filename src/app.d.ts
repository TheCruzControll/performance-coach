// See https://svelte.dev/docs/kit/types#app.d.ts
import type { AuthSession } from '#lib/server/auth/sessions.ts';

declare global {
	namespace App {
		interface Error {
			/** Correlates a user-visible error with server logs and the app_errors table. */
			requestId?: string;
			/** Set by src/hooks.client.ts when the failure was the network, not the server. */
			offline?: boolean;
		}
		interface Locals {
			requestId: string;
			/** The live session (src/lib/server/auth/guard.ts), or null when signed out. */
			session: AuthSession | null;
		}
		// interface PageData {}
		interface PageState {
			/** History's exercise-history sheet, shallow-routed so Back closes it (pushState). */
			exerciseHistory?: { exerciseId: string; name: string };
			/** A coach answer's exercise source: its history sheet, by exercise id alone (pushState). */
			coachExercise?: { exerciseId: string };
		}
		// interface Platform {}
	}
}

export {};
