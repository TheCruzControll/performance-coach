/**
 * Passkey authentication (ADR 0006, docs/security.md). Routes and hooks import from here.
 */
export type { AuthDeps, AuthRequest } from './context';
export { AuthError, isAuthError, type AuthErrorCode } from './errors';
export {
	authErrorResponse,
	authRequest,
	clearSessionCookie,
	NO_STORE,
	readJsonBody,
	readSessionToken,
	relyingParty,
	setSessionCookie
} from './http';
export {
	beginPasskeyRegistration,
	beginSignIn,
	completePasskeyRegistration,
	completeSignIn,
	listPasskeys,
	removePasskey,
	renamePasskey,
	type PasskeyView
} from './passkeys';
export { recoveryCodeStatus, redeemRecoveryCode, regenerateRecoveryCodes } from './recovery';
export { RECOVERY_CODE_COUNT } from './recovery-codes';
export { DEFAULT_RETURN_PATH, safeReturnPath } from './return-path';
export { RECOVERY_PASSKEY_PATH } from './routes';
export {
	listSessions,
	revokeOtherSessions,
	revokeSession,
	signOut,
	type AuthSession,
	type SessionSummary
} from './sessions';
export { beginSetup, checkSetupAccess, completeSetup, setupOpen } from './setup';
export { recentAuthActivity, type AuthActivity } from './activity';
