import { saveBasics } from '#lib/server/services/profile/index.ts';
import { stepActions } from '../profile-forms.server';
import type { Actions } from './$types';

export const actions: Actions = stepActions('welcome', saveBasics);
