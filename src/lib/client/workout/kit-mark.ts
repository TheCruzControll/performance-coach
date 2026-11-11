/**
 * Which workout the start flow began from a kit saved on this device (start.ts's `refresh`), so its
 * page fetches the fresh kit (kit-refresh.ts). In sessionStorage: it outlives the start flow's
 * location.replace, in this tab only, and holds nothing but a client id. Kept until a refresh is
 * answered, so a start with no signal refreshes on a later load of the page. Tiny and separate, so
 * the workout page reads it without loading the refresh.
 */
export const KIT_REFRESH_KEY = 'pc:kit-refresh:v1';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Storage that refuses (private mode, disabled) leaves the kit as saved: never an error. */
const quietly = <T>(run: () => T, fallback: T): T => {
	try {
		return run();
	} catch {
		return fallback;
	}
};

export const markKitRefresh = (workoutId: string, storage: Storage = sessionStorage) =>
	quietly(() => storage.setItem(KIT_REFRESH_KEY, workoutId), undefined);

export const kitRefreshMarked = (workoutId: string, storage: Storage = sessionStorage) =>
	quietly(() => storage.getItem(KIT_REFRESH_KEY) === workoutId, false);

export const clearKitRefresh = (storage: Storage = sessionStorage) =>
	quietly(() => storage.removeItem(KIT_REFRESH_KEY), undefined);
