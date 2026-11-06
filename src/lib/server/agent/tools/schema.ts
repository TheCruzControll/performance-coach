/**
 * A zod/mini schema as the JSON Schema strict tool use accepts (the claude-api skill's limits, and
 * the SDK's transform-json-schema): a tool's input schema, and its output schema for the docs.
 *
 * - Every object is closed (additionalProperties: false) and lists its required keys.
 * - Kept: type, description, title, enum, const, anyOf (oneOf and nullable become anyOf), allOf,
 *   items, minItems of 0 or 1, and the formats strict mode knows (their own pattern is dropped).
 * - Any other keyword (minimum, maxLength, maxItems, pattern, default…) moves into the
 *   description as `{key: value}`, as the SDK writes it; zod still enforces it before a tool runs.
 * - Refused: recursion, $ref, records, tuples, untyped values, the other keywords whose value is
 *   a schema, and any property that names an owner: a tool acts on the session's owner only.
 */
import * as z from 'zod/mini';

export type JsonSchema = { [keyword: string]: unknown };

export class ToolSchemaError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'ToolSchemaError';
	}
}

const FORMATS = new Set(
	'date-time time date duration email hostname uri ipv4 ipv6 uuid'.split(' ')
);
const REFUSED = [
	...'$ref $defs definitions prefixItems additionalItems propertyNames patternProperties'.split(
		' '
	),
	...'unevaluatedProperties unevaluatedItems contains not if then else dependentSchemas'.split(' ')
];
/** owner, ownerId, owner_id, OwnerID, owner-id. */
const OWNER = /^owner[_-]?(id)?$/i;
/** z.int()'s own range, which every integer carries and no description needs. */
const SAFE_INTEGER = { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };

/** `schema` as a strict tool JSON Schema; `io` picks what a default means (absent or present). */
export function toStrictJsonSchema(
	schema: z.ZodMiniType,
	io: 'input' | 'output' = 'input'
): JsonSchema {
	let json: JsonSchema;
	try {
		json = z.toJSONSchema(schema, { io, cycles: 'throw' }) as JsonSchema;
	} catch (cause) {
		const why = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
		throw new ToolSchemaError(`This cannot be a strict tool schema: ${why}`, { cause });
	}
	const { $schema: _dialect, ...root } = json;
	return strict(root, '$');
}

/** zod writes a nullable primitive as `type: [T, 'null']`; this states it as anyOf. */
function splitNullable({ type, title, description, ...inner }: JsonSchema, at: string) {
	const other = (type as unknown[]).filter((each) => each !== 'null');
	if ((type as unknown[]).length !== 2 || other.length !== 1)
		throw new ToolSchemaError(`${at} has no type`);
	const said = {
		...(title !== undefined && { title }),
		...(description !== undefined && { description })
	};
	return { ...said, anyOf: [{ ...inner, type: other[0] }, { type: 'null' }] };
}

function strict(node: unknown, at: string): JsonSchema {
	if (!node || typeof node !== 'object' || Array.isArray(node))
		throw new ToolSchemaError(`${at} is not a schema strict tool use can state`);
	if (Array.isArray((node as JsonSchema).type))
		return strict(splitNullable(node as JsonSchema, at), at);
	const rest: JsonSchema = { ...node };
	const take = (key: string) => {
		const value = rest[key];
		delete rest[key];
		return value;
	};
	for (const key of REFUSED)
		if (key in rest) throw new ToolSchemaError(`${at}: strict tool use has no ${key}`);

	const out: JsonSchema = {};
	const variants = take('anyOf') ?? take('oneOf');
	const parts = take('allOf');
	if ('oneOf' in rest) throw new ToolSchemaError(`${at} has both anyOf and oneOf`);
	if (Array.isArray(variants)) out.anyOf = variants.map((v, i) => strict(v, `${at}.anyOf[${i}]`));
	if (Array.isArray(parts)) out.allOf = parts.map((p, i) => strict(p, `${at}.allOf[${i}]`));
	const type = take('type');
	if (typeof type === 'string') out.type = type;
	else if (type !== undefined || (!out.anyOf && !out.allOf))
		throw new ToolSchemaError(`${at} has no type`);
	for (const key of ['description', 'title', 'enum', 'const'])
		if (key in rest) out[key] = take(key);

	if (type === 'object') {
		const extra = take('additionalProperties');
		if (extra !== undefined && extra !== false)
			throw new ToolSchemaError(`${at}: strict tool use needs additionalProperties: false`);
		const properties = Object.entries((take('properties') ?? {}) as JsonSchema);
		out.properties = Object.fromEntries(
			properties.map(([name, child]) => {
				if (OWNER.test(name))
					throw new ToolSchemaError(`${at}.${name}: a tool acts on the session's owner only`);
				return [name, strict(child, `${at}.${name}`)];
			})
		);
		out.required = take('required') ?? [];
		out.additionalProperties = false;
	} else if (type === 'array') {
		if ('items' in rest) out.items = strict(take('items'), `${at}[]`);
		if (rest.minItems === 0 || rest.minItems === 1) out.minItems = take('minItems');
	} else if (type === 'string' && FORMATS.has(rest.format as string)) {
		out.format = take('format');
		delete rest.pattern;
	} else if (type === 'integer') {
		for (const [key, bound] of Object.entries(SAFE_INTEGER))
			if (rest[key] === bound) delete rest[key];
	}

	const described = Object.entries(rest).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
	if (described.length > 0) {
		const bounds = `{${described.join(', ')}}`;
		out.description = out.description ? `${out.description}\n\n${bounds}` : bounds;
	}
	return out;
}
