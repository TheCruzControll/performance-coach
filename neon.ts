/**
 * Neon infrastructure-as-code (https://neon.com/docs/reference/neon-ts).
 *
 * Declares Lakebase Postgres only. Every Neon project ships with Postgres, so no service
 * toggles are enabled: no Neon Auth (passkeys are implemented in-app, see ADR 0006), no
 * Data API, Functions, buckets or AI Gateway. Apply with `neon deploy` once the owner has
 * linked the project (`neon link`); see docs/deployment.md.
 */
import { defineConfig } from '@neon/config/v1';

export default defineConfig({
	branch: (branch) => {
		// Leave existing branches (including production) untouched.
		if (branch.exists || branch.isDefault) return {};
		// New preview/dev branches: short-lived and cheap, scale to zero quickly.
		return {
			ttl: '7d',
			postgres: {
				computeSettings: {
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 1,
					suspendTimeout: '5m'
				}
			}
		};
	}
});
