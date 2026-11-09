/**
 * Weekly and cycle reviews, program versions and proposal chains, read in SQL for the review
 * specs to compare the screens with. No app code: each definition is written out here, and a new
 * figure gets a new file, never an edit.
 *
 * - A review is stored in revisions: a refresh marks the live row superseded_at and
 *   superseded_by, then inserts the next revision. The live one has no superseded_at.
 * - A proposal's revision points back at what it revises (revision_of); its head is the newest
 *   revision reached forward from any link of the chain, and the decision is the head's status.
 */
import { query } from '../support';

export interface ReviewRow {
	id: string;
	revision: number;
	live: boolean;
	supersededBy: string | null;
	summary: string;
	narrative: string | null;
	proposalId: string | null;
	/** The program version it reviewed, by number; null without one. */
	versionNumber: number | null;
	snapshotVersion: number;
	analyticsVersion: number;
}

export interface WeeklyReviewRow extends ReviewRow {
	weekStartsOn: string;
}

export interface CycleReviewRow extends ReviewRow {
	blockLineageId: string;
	blockStartsOn: string | null;
	blockEndsOn: string | null;
	/** The version that plans the next block, by number; null until it is planned. */
	nextVersionNumber: number | null;
}

const REVIEW = (t: string) => `${t}.id::text, ${t}.revision, ${t}.superseded_at is null as live,
	${t}.superseded_by::text as "supersededBy", ${t}.summary, ${t}.narrative,
	${t}.proposal_id::text as "proposalId", v.number as "versionNumber",
	${t}.snapshot_version as "snapshotVersion", ${t}.analytics_version as "analyticsVersion"`;

/** Every revision of the owner's review of the week from `weekStartsOn`, oldest first. */
export function weeklyReviews(weekStartsOn: string): Promise<WeeklyReviewRow[]> {
	return query<WeeklyReviewRow>(
		`select ${REVIEW('r')}, to_char(r.week_starts_on, 'YYYY-MM-DD') as "weekStartsOn"
		from weekly_reviews r left join program_versions v on v.id = r.version_id
		where r.week_starts_on = $1::date order by r.revision`,
		[weekStartsOn]
	);
}

/** Every revision of the review of the block with lineage `blockLineageId`, oldest first. */
export function cycleReviews(blockLineageId: string): Promise<CycleReviewRow[]> {
	return query<CycleReviewRow>(
		`select ${REVIEW('r')}, r.block_lineage_id::text as "blockLineageId",
			to_char(r.block_starts_on, 'YYYY-MM-DD') as "blockStartsOn",
			to_char(r.block_ends_on, 'YYYY-MM-DD') as "blockEndsOn", n.number as "nextVersionNumber"
		from cycle_reviews r
		left join program_versions v on v.id = r.version_id
		left join program_versions n on n.id = r.next_version_id
		where r.block_lineage_id = $1::uuid order by r.revision`,
		[blockLineageId]
	);
}

export interface DecisionRow {
	kind: string;
	ruleKey: string | null;
	summary: string;
	why: string;
	decidedBy: string;
}

export interface VersionRow {
	id: string;
	number: number;
	parentNumber: number | null;
	/** Who made it: rules, coach or owner. */
	createdBy: string;
	summary: string;
	generator: string | null;
	current: boolean;
	/** The decisions stored with it, in the order they were stored. */
	decisions: DecisionRow[];
}

/** Every version of program `programId`, the first first, with its decisions and author. */
export function programVersions(programId: string): Promise<VersionRow[]> {
	return query<VersionRow>(
		`select v.id::text, v.number, parent.number as "parentNumber", v.created_by as "createdBy",
			v.summary, v.generator, p.current_version_id = v.id as current,
			coalesce((select json_agg(json_build_object('kind', d.kind, 'ruleKey', d.rule_key,
					'summary', d.summary, 'why', d.why, 'decidedBy', d.decided_by) order by d.id)
				from programming_decisions d where d.version_id = v.id), '[]') as decisions
		from program_versions v
		join programs p on p.id = v.program_id
		left join program_versions parent on parent.id = v.parent_version_id
		where v.program_id = $1::uuid order by v.number`,
		[programId]
	);
}

export interface ProposalLink {
	id: string;
	revisionOf: string | null;
	status: string;
	supersededReason: string | null;
	/** The version it was applied as, by number; null unless applied to a program version. */
	appliedVersionNumber: number | null;
}

export interface ProposalChain {
	/** From the first proposal to the head. */
	chain: ProposalLink[];
	head: ProposalLink;
}

/** The revision chain through proposal `proposalId`, from its first proposal to its head. */
export async function proposalChain(proposalId: string): Promise<ProposalChain> {
	const chain = await query<ProposalLink>(
		`with recursive back as (
			select id, revision_of, 0 as depth from coach_proposals where id = $1::uuid
			union all
			select p.id, p.revision_of, b.depth - 1 from coach_proposals p join back b on p.id = b.revision_of
		),
		forward as (
			select id, 0 as depth from coach_proposals where id = $1::uuid
			union all
			select p.id, f.depth + 1 from coach_proposals p join forward f on p.revision_of = f.id
		),
		links as (select id, depth from back union select id, depth from forward)
		select p.id::text, p.revision_of::text as "revisionOf", p.status,
			p.superseded_reason as "supersededReason", v.number as "appliedVersionNumber"
		from links l
		join coach_proposals p on p.id = l.id
		left join program_versions v on v.id = p.applied_version_id
		order by l.depth, p.created_at, p.id`,
		[proposalId]
	);
	return { chain, head: chain.at(-1)! };
}
