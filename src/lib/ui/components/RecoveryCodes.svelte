<!--
  @component
  The one-time display of a fresh set of recovery codes: numbered, monospaced, copy and
  download actions, and an explicit acknowledgement before the owner may continue. The codes
  exist in plain text only here (the server stores hashes), so leaving without saving them means
  creating a new set later.
-->
<script lang="ts">
	import { toast } from '../toast.svelte.ts';
	import Button from './Button.svelte';
	import Icon from './Icon.svelte';

	interface Props {
		codes: string[];
		acknowledged?: boolean;
		'data-testid'?: string;
	}

	let { codes, acknowledged = $bindable(false), 'data-testid': testId }: Props = $props();

	function asText(): string {
		const date = new Date().toISOString().slice(0, 10);
		return [
			'Performance Coach — recovery codes',
			`${location.host} · created ${date}`,
			'',
			'Each code works once. If you lose your passkeys, open the sign-in screen,',
			'choose "Use a recovery code", then add a new passkey.',
			'',
			...codes.map((code, i) => `${String(i + 1).padStart(2, '0')}  ${code}`),
			''
		].join('\n');
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(asText());
			toast.show('Recovery codes copied', { tone: 'positive' });
		} catch {
			toast.show('Couldn’t copy. Download the codes instead.', { tone: 'danger' });
		}
	}

	function download() {
		const url = URL.createObjectURL(new Blob([asText()], { type: 'text/plain' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = 'performance-coach-recovery-codes.txt';
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1_000);
	}
</script>

<div class="codes-card" data-testid={testId}>
	<ol class="codes" aria-label="Recovery codes">
		{#each codes as code, i (code)}
			<!-- Three groups to a line: a 24-character code never fits a phone row on one. -->
			{@const cut = Math.ceil(code.length / 2)}
			<li class="code" data-testid="recovery-code">
				<span class="index numeric" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
				<span class="value"
					><span class="line">{code.slice(0, cut)}</span><span class="line">{code.slice(cut)}</span
					></span
				>
			</li>
		{/each}
	</ol>

	<div class="tools">
		<Button variant="secondary" size="sm" icon="copy" onclick={copy} data-testid="copy-codes">
			Copy
		</Button>
		<Button
			variant="secondary"
			size="sm"
			icon="download"
			onclick={download}
			data-testid="download-codes"
		>
			Download
		</Button>
	</div>

	<label class="ack">
		<input type="checkbox" bind:checked={acknowledged} data-testid="ack-codes" />
		<span class="box" aria-hidden="true"><Icon name="check" size={16} strokeWidth={2.5} /></span>
		<span class="ack-text">I’ve saved these codes somewhere safe</span>
	</label>
</div>

<style>
	.codes-card {
		display: grid;
		gap: var(--space-4);
		container-type: inline-size;
	}

	/* One code per row on a phone, two columns when there is room; a code never clips. */
	.codes {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1px;
		margin: 0;
		padding: 0;
		list-style: none;
		border-radius: var(--radius-lg);
		overflow: hidden;
		border: 1px solid var(--color-border);
		background: var(--color-hairline);
	}

	/* From 40rem a column holds three groups of even the widest letters. */
	@container (min-width: 40rem) {
		.codes {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	/* Two snug lines and a slim padding keep ten codes short enough that the desktop setup card's
	   controls stay inside a 900 px window. */
	.code {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		min-height: 2.75rem;
		padding: var(--space-1-5) var(--space-4);
		background: var(--color-surface-1);
	}

	.index {
		flex: none;
		width: 1.25rem;
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.value {
		font-family: var(--font-numeric);
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.06em;
		line-height: var(--leading-snug);
		user-select: all;
	}

	/* Each half of a code on its own line, broken only between groups. */
	.line {
		display: block;
		white-space: nowrap;
	}

	.tools {
		display: flex;
		gap: var(--space-2);
	}

	.ack {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: var(--touch-target);
		cursor: pointer;
	}

	.ack input {
		position: absolute;
		inset: 0;
		opacity: 0;
		margin: 0;
		cursor: pointer;
	}

	.box {
		display: grid;
		place-items: center;
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-xs);
		border: 1.5px solid var(--color-border-strong);
		background: var(--color-surface-2);
		color: transparent;
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard);
	}

	.ack input:checked + .box {
		background: var(--color-accent);
		border-color: var(--color-accent);
		color: var(--color-on-accent);
	}

	.ack input:focus-visible + .box {
		box-shadow: 0 0 0 3px var(--color-accent-ring);
	}

	.ack-text {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}
</style>
