/**
 * Toast queue (client-side state). Call `toast.show(...)` from event handlers only; toasts are
 * never created during SSR.
 */
export type ToastTone = 'neutral' | 'positive' | 'danger';

export interface ToastItem {
	id: number;
	message: string;
	tone: ToastTone;
	action?: { label: string; onclick: () => void };
	duration: number;
}

class ToastQueue {
	items = $state<ToastItem[]>([]);
	#seq = 0;
	#timers = new Map<number, ReturnType<typeof setTimeout>>();

	show(
		message: string,
		options: { tone?: ToastTone; action?: ToastItem['action']; duration?: number } = {}
	): number {
		const id = ++this.#seq;
		const item: ToastItem = {
			id,
			message,
			tone: options.tone ?? 'neutral',
			action: options.action,
			duration: options.duration ?? 4000
		};
		// Keep at most three; the oldest leaves first.
		this.items = [...this.items.slice(-2), item];
		if (item.duration > 0)
			this.#timers.set(
				id,
				setTimeout(() => this.dismiss(id), item.duration)
			);
		return id;
	}

	dismiss(id: number): void {
		clearTimeout(this.#timers.get(id));
		this.#timers.delete(id);
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const toast = new ToastQueue();
