/**
 * PLACEHOLDER, replaced only by coach-tool-catalogue (m5/02): the words an activity chip shows
 * while a tool runs, once it is done and if it fails ('Looking at your last 6 bench sessions…',
 * 'Drafting the change…'). They never show a raw id. Until that slice lands there is no tool to
 * describe, so activityLabel throws.
 */
import type { ActivityState } from './events.ts';
import type { ToolName } from './tools.ts';

export type ActivityWording = Readonly<Record<ActivityState, string>>;

export function activityLabel(tool: ToolName, _input: unknown, _output?: unknown): ActivityWording {
	throw new Error(`activityLabel(${tool}) arrives with the tool catalogue (coach-tool-catalogue)`);
}
