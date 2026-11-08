/**
 * A Writable that keeps everything written to it in memory, up to a cap. The backup run seals
 * into one so the export's transaction never waits on a network: the upload starts only once the
 * sealed bytes are all here (M9 'export first, upload after commit').
 *
 * Going over the cap fails the stream with BufferCapError and drops what was collected, so a
 * runaway export costs at most `cap` bytes.
 */
import { Writable } from 'node:stream';

export class BufferCapError extends Error {
	readonly cap: number;

	constructor(cap: number) {
		super(`The buffer is over its cap of ${cap} bytes`);
		this.name = 'BufferCapError';
		this.cap = cap;
	}
}

export class BoundedBuffer extends Writable {
	readonly cap: number;
	#chunks: Buffer[] = [];
	#size = 0;

	constructor(cap: number) {
		super();
		if (!Number.isSafeInteger(cap) || cap < 0) {
			throw new RangeError('A buffer cap is a whole number of bytes');
		}
		this.cap = cap;
	}

	/** The bytes collected so far. */
	get size(): number {
		return this.#size;
	}

	/** Everything written, as one Buffer. */
	contents(): Buffer {
		return Buffer.concat(this.#chunks, this.#size);
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
		if (this.#size + chunk.length > this.cap) {
			this.#chunks = [];
			this.#size = 0;
			done(new BufferCapError(this.cap));
			return;
		}
		this.#chunks.push(chunk);
		this.#size += chunk.length;
		done();
	}
}
