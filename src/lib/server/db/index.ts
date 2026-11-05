export { closeDb, createDatabase, createPool, getDb } from './client';
export { createAppErrorsRepository } from './repositories/app-errors';
export type { AppErrorRow, NewAppError } from './repositories/app-errors';
export { createAuthRepository } from './repositories/auth';
export type {
	ActiveSession,
	AuthEventRow,
	AuthRepository,
	ChallengeRow,
	OwnerRow,
	PasskeyRow,
	SessionRow
} from './repositories/auth';
export { createSystemRepository } from './repositories/system';
export { createWebVitalsRepository } from './repositories/web-vitals';
export type { NewWebVital, VitalSummaryRow, WebVitalRow } from './repositories/web-vitals';
export * from './schema';
export type { Database, Executor, Schema } from './types';
