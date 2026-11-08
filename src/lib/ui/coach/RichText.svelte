<!--
  @component
  An answer block's words (domain/coach/rich.ts) as elements: paragraphs, lists, emphasis,
  strong, code, links and refs. Never `{@html}`: every string is a text node, so markup, entities
  and markdown the server left literal stay literal. A link renders only for an app path (the
  server sends no other, see sourceAction); anything else shows its words as text. A ref shows its
  label; its action lives in the block's sources.
-->
<script lang="ts">
	import type { RichNode } from '#lib/domain/coach/index.ts';

	let { nodes }: { nodes: readonly RichNode[] } = $props();

	/** An app path: one leading slash, never `//` or a backslash that a browser reads as one. */
	const appPath = (href: string) => /^\/(?![/\\])/.test(href) && !href.includes('\\');
</script>

{#snippet node(n: RichNode)}
	{#if n.type === 'paragraph'}
		<p>
			{#each n.children as child, i (i)}{@render node(child)}{/each}
		</p>
	{:else if n.type === 'list' && n.ordered}
		<ol>
			{#each n.children as child, i (i)}{@render node(child)}{/each}
		</ol>
	{:else if n.type === 'list'}
		<ul>
			{#each n.children as child, i (i)}{@render node(child)}{/each}
		</ul>
	{:else if n.type === 'item'}
		<li>
			{#each n.children as child, i (i)}{@render node(child)}{/each}
		</li>
	{:else if n.type === 'emphasis'}
		<em
			>{#each n.children as child, i (i)}{@render node(child)}{/each}</em
		>
	{:else if n.type === 'strong'}
		<strong
			>{#each n.children as child, i (i)}{@render node(child)}{/each}</strong
		>
	{:else if n.type === 'link' && appPath(n.href)}
		<a href={n.href}
			>{#each n.children as child, i (i)}{@render node(child)}{/each}</a
		>
	{:else if n.type === 'link'}
		{#each n.children as child, i (i)}{@render node(child)}{/each}
	{:else if n.type === 'code'}
		<code>{n.text}</code>
	{:else if n.type === 'ref'}
		<span class="ref">{n.label}</span>
	{:else}
		{n.text}
	{/if}
{/snippet}

<div class="rich">
	{#each nodes as n, i (i)}{@render node(n)}{/each}
</div>

<style>
	.rich {
		display: grid;
		gap: var(--space-2);
		min-width: 0;
		overflow-wrap: anywhere;
		line-height: var(--leading-normal);
	}

	/* The server keeps a single newline inside a paragraph as '\n'. */
	p,
	li {
		white-space: pre-line;
	}

	ul,
	ol {
		display: grid;
		gap: var(--space-1);
		padding-left: var(--space-5);
	}

	ul {
		list-style: disc;
	}

	ol {
		list-style: decimal;
	}

	strong {
		font-weight: var(--weight-semibold);
	}

	/* Only the upright font ships: let the browser slant it rather than drop the emphasis. */
	em {
		font-style: italic;
		font-synthesis-style: auto;
	}

	code {
		padding: 0 var(--space-1);
		border-radius: var(--radius-xs);
		background: var(--color-surface-2);
		font-family: var(--font-numeric);
		font-size: 0.92em;
	}

	.ref {
		font-weight: var(--weight-medium);
	}

	a {
		color: var(--color-accent-text);
		text-decoration: underline;
		text-underline-offset: 0.18em;
	}

	@media (hover: hover) and (pointer: fine) {
		a:hover {
			text-decoration-thickness: 2px;
		}
	}
</style>
