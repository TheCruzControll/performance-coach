import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { BoundedBuffer, BufferCapError } from './bounded-buffer';

const chunks = (...sizes: number[]) =>
	Readable.from(sizes.map((size, i) => Buffer.alloc(size, i + 1)));

describe('BoundedBuffer', () => {
	it('collects every chunk, in order, up to and including its cap', async () => {
		const sink = new BoundedBuffer(10);
		await pipeline(chunks(4, 6), sink);
		expect(sink.size).toBe(10);
		expect(sink.contents()).toEqual(Buffer.concat([Buffer.alloc(4, 1), Buffer.alloc(6, 2)]));
	});

	it('fails with BufferCapError on the first byte over its cap, and drops what it held', async () => {
		const sink = new BoundedBuffer(10);
		const error = await pipeline(chunks(4, 6, 1), sink).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(BufferCapError);
		expect((error as BufferCapError).cap).toBe(10);
		expect(sink.size).toBe(0);
		expect(sink.contents()).toHaveLength(0);
	});

	it('refuses a cap that is not a whole number of bytes', () => {
		expect(() => new BoundedBuffer(-1)).toThrow(RangeError);
		expect(() => new BoundedBuffer(1.5)).toThrow(RangeError);
	});
});
