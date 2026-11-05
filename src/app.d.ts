// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Error {
			/** Correlates a user-visible error with server logs and the app_errors table. */
			requestId?: string;
		}
		interface Locals {
			requestId: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
