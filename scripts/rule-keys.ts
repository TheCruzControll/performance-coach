/**
 * The rule keys code cites (m7 plan, rules registry): every key a programming decision can carry,
 * so each registry slice and the rules reference can prove that every one resolves to a registry
 * entry. Never edited after rules-registry-m3: callers pass their own source globs and decisions.
 *
 * Statically, under the given globs (test files skipped), a cited key is:
 * - a string passed to a parameter named `ruleKey` (DecisionLog.add's second, placement's drop)
 * - the second argument of a call whose first is a decision kind literal (placement's note)
 * - the value of a `ruleKey` property in an object literal (an assumption, a result's outcome)
 * A template key is expanded over its spans' declared literal unions, a conditional over both
 * branches, and a const holding a template over its initializer; a template the scanner cannot
 * expand throws, naming its file and line, so a key cannot hide. Comments are never read.
 *
 * Dynamically: every ruleKey in the decisions of M3's seven scenario plans, every DEFAULTS key as
 * `defaults.<key>`, and any decisions a caller passes (its own fixtures).
 *
 * It lives in scripts/ because the domain lint block forbids node:fs.
 */
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CATALOGUE } from '../src/lib/domain/exercises/index.ts';
import { buildProgrammingInput, generateProgram } from '../src/lib/domain/programming/index.ts';
import { DEFAULTS } from '../src/lib/domain/programming/rules/defaults.ts';
import { SCENARIO_START, SCENARIOS } from '../src/lib/domain/programming/scenarios.ts';
import type { ScenarioKey } from '../src/lib/domain/programming/scenarios.ts';
import { DECISION_KINDS } from '../src/lib/domain/training/vocabulary.ts';

/** The repository root: what globs are relative to. */
export const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** A decision as far as its rule key goes. */
export interface CitingDecision {
	ruleKey: string | null;
}

const KINDS: ReadonlySet<string> = new Set(DECISION_KINDS);

/** The .ts files `globs` name from `root`: a leading '!' excludes; tests are never read. */
export function sourceFiles(globs: readonly string[], root = ROOT): string[] {
	const include = globs.filter((g) => !g.startsWith('!'));
	const exclude = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
	return globSync(include, { cwd: root })
		.filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
		.filter((file) => !exclude.some((g) => path.matchesGlob(file, g)))
		.sort()
		.map((file) => path.join(root, file));
}

/** The keys a statically scanned files' citations name. */
export function staticRuleKeys(globs: readonly string[], root = ROOT): Set<string> {
	const files = sourceFiles(globs, root);
	const program = ts.createProgram(files, {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: []
	});
	const checker = program.getTypeChecker();
	const keys = new Set<string>();

	/**
	 * Every literal a type allows, or null when it allows any string. null and undefined are left
	 * out: the checker does not narrow `x` by a guard on another value (`phase ? x : …`).
	 */
	const literalsOf = (type: ts.Type): string[] | null => {
		const values: string[] = [];
		for (const part of type.isUnion() ? type.types : [type]) {
			if (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
			if (part.isStringLiteral() || part.isNumberLiteral()) values.push(String(part.value));
			else if (part.flags & ts.TypeFlags.BooleanLiteral) values.push(checker.typeToString(part));
			else return null;
		}
		return values.length ? values : null;
	};

	const where = (node: ts.Node) => {
		const source = node.getSourceFile();
		const { line } = source.getLineAndCharacterOfPosition(node.getStart());
		return `${path.relative(root, source.fileName)}:${line + 1}`;
	};

	/** What `node` can evaluate to, or null when it can be any string. */
	const expand = (node: ts.Expression): string[] | null => {
		if (ts.isStringLiteralLike(node)) return [node.text];
		if (ts.isParenthesizedExpression(node)) return expand(node.expression);
		if (ts.isConditionalExpression(node)) {
			const [a, b] = [expand(node.whenTrue), expand(node.whenFalse)];
			return a && b ? [...a, ...b] : null;
		}
		if (ts.isTemplateExpression(node)) {
			let texts = [node.head.text];
			for (const span of node.templateSpans) {
				const values = expand(span.expression);
				if (!values) throw new Error(`${where(span)}: cannot expand the rule key template`);
				texts = texts.flatMap((t) => values.map((v) => t + v + span.literal.text));
			}
			return texts;
		}
		const literals = literalsOf(checker.getTypeAtLocation(node));
		if (literals) return literals;
		if (ts.isIdentifier(node)) {
			const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
			const constant =
				declaration &&
				ts.isVariableDeclaration(declaration) &&
				ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const;
			if (constant && declaration.initializer) return expand(declaration.initializer);
		}
		return null;
	};
	/** A cited expression: a variable passing a key through is not a citation of its own. */
	const cite = (node: ts.Expression) => expand(node)?.forEach((key) => keys.add(key));

	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const [first, second] = node.arguments;
			if (first && second && ts.isStringLiteralLike(first) && KINDS.has(first.text)) {
				cite(second);
			} else {
				const signature = checker.getResolvedSignature(node);
				node.arguments.forEach((arg, i) => {
					if (signature?.parameters[i]?.name === 'ruleKey') cite(arg);
				});
			}
		}
		if (ts.isPropertyAssignment(node) && node.name.getText() === 'ruleKey') cite(node.initializer);
		ts.forEachChild(node, visit);
	};
	for (const file of files) visit(program.getSourceFile(file)!);
	return keys;
}

/** The keys M3's seven scenario plans cite, each planned from SCENARIO_START, and DEFAULTS'. */
export function scenarioRuleKeys(): Set<string> {
	const keys = new Set(Object.keys(DEFAULTS).map((key) => `defaults.${key}`));
	for (const key of Object.keys(SCENARIOS) as ScenarioKey[]) {
		const input = buildProgrammingInput(SCENARIOS[key](), { catalogue: CATALOGUE });
		const start = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
		for (const { ruleKey } of generateProgram(input, start).decisions) keys.add(ruleKey);
	}
	return keys;
}

/** Every rule key cited under `globs`, by the scenario plans, and by `decisions`. */
export function citedRuleKeys(
	globs: readonly string[],
	decisions: Iterable<CitingDecision> = [],
	root = ROOT
): Set<string> {
	const keys = new Set([...staticRuleKeys(globs, root), ...scenarioRuleKeys()]);
	for (const { ruleKey } of decisions) if (ruleKey) keys.add(ruleKey);
	return keys;
}
