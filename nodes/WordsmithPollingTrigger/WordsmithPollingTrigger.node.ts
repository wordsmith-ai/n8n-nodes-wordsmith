import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { TASK_STATUSES } from '../Wordsmith/descriptions/taskJob';
import {
	authenticationProperties,
	credentialsFor,
	NODE_VERSIONS,
	wordsmithList,
} from '../shared/transport';

const SEEN_KEYS_KEPT = 2000;
const OPEN_TASK_STATUSES = 'not_started,in_progress,waiting_on_external';

interface Poll {
	path: string;
	qs: IDataObject;
	limit: number;
	/** What makes an item new: its id, or for a status change its id and status. */
	key: (item: IDataObject) => string;
	output: (item: IDataObject) => IDataObject;
}

/** The list each trigger reads, from the catalogue's polling routes. */
export function pollFor(trigger: string, status: string): Poll {
	if (trigger === 'task_created') {
		return {
			path: '/tasks',
			qs: { status: OPEN_TASK_STATUSES, involving: 'me' },
			limit: 100,
			key: (task) => String(task.id),
			output: (task) => ({ task }),
		};
	}
	if (trigger === 'task_status_changed') {
		return {
			path: '/tasks',
			qs: { status },
			limit: 100,
			key: (task) => `${String(task.id)}:${String(task.status)}`,
			output: (task) => ({ task, status: task.status }),
		};
	}
	return {
		path: '/reviews',
		qs: { status: 'completed' },
		limit: 50,
		key: (review) => String(review.id),
		output: (review) => ({
			review,
			findings: review.findings ?? null,
			redline_file_id: review.redline_file_id ?? null,
		}),
	};
}

/**
 * Items not seen before. The first poll only records what exists, so turning the workflow on does not
 * replay old work.
 */
export function newItems(
	items: IDataObject[],
	key: (item: IDataObject) => string,
	staticData: IDataObject,
): IDataObject[] {
	const seen = staticData.seenKeys as string[] | undefined;
	const keys = items.map(key);
	const current = new Set(keys);
	// Keys still listed move to the end, so the cap drops only keys that left the list.
	staticData.seenKeys = [...(seen ?? []).filter((k) => !current.has(k)), ...current].slice(
		-SEEN_KEYS_KEPT,
	);
	if (seen === undefined) return [];
	const before = new Set(seen);
	return items.filter((_, index) => !before.has(keys[index]));
}

export class WordsmithPollingTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Wordsmith Polling Trigger',
		name: 'wordsmithPollingTrigger',
		icon: {
			light: 'file:../Wordsmith/wordsmith.svg',
			dark: 'file:../Wordsmith/wordsmith.dark.svg',
		},
		group: ['trigger'],
		...NODE_VERSIONS,
		subtitle: '={{$parameter["event"]}}',
		description: 'Checks Wordsmith on a schedule and starts the workflow for new tasks and reviews',
		defaults: { name: 'Wordsmith Polling Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: credentialsFor(),
		properties: [
			...authenticationProperties,
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				required: true,
				options: [
					{
						name: 'New Task',
						value: 'task_created',
						description: 'Starts when an open task involving you appears',
					},
					{
						name: 'Review Completed',
						value: 'review_completed',
						description: 'Starts when a review finishes',
					},
					{
						name: 'Task Status Changed',
						value: 'task_status_changed',
						description: 'Starts when a task reaches the status you choose',
					},
				],
				default: 'task_status_changed',
			},
			{
				displayName: 'New Status',
				name: 'status',
				type: 'options',
				options: TASK_STATUSES,
				default: 'completed',
				displayOptions: { show: { event: ['task_status_changed'] } },
			},
			{
				displayName:
					'New Task reads open tasks by priority, so on a busy account a task beyond the first 100 can be missed. Use the Wordsmith Trigger where instant triggers are on.',
				name: 'notice',
				type: 'notice',
				default: '',
				displayOptions: { show: { event: ['task_created'] } },
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const trigger = this.getNodeParameter('event') as string;
		const status = this.getNodeParameter('status', 'completed') as string;
		const poll = pollFor(trigger, status);
		const items = await wordsmithList.call(this, poll.path, poll.qs, poll.limit);
		if (this.getMode() === 'manual') {
			return items.length > 0 ? [this.helpers.returnJsonArray(poll.output(items[0]))] : null;
		}
		const fresh = newItems(items, poll.key, this.getWorkflowStaticData('node'));
		if (fresh.length === 0) return null;
		return [this.helpers.returnJsonArray(fresh.map(poll.output))];
	}
}
