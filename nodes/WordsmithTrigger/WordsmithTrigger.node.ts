import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { TASK_STATUSES } from '../Wordsmith/descriptions/taskJob';
import { getEventTypes } from '../shared/methods';
import { verifySignature } from '../shared/signature';
import {
	triggerAuthenticationProperties,
	NODE_VERSIONS,
	credentialsFor,
	id,
	wordsmithApi,
	wordsmithRequest,
} from '../shared/transport';

const TEST_EVENT = 'webhook_endpoint.test';
const STATUS_FILTERS = [{ name: 'Any Status', value: 'any' }, ...TASK_STATUSES];
const SEEN_EVENTS_KEPT = 200;

/** The event types each trigger subscribes to, and the read that turns an event into its resource. */
export const TRIGGERS: Record<
	string,
	{
		eventTypes: string[];
		enrich?: (data: IDataObject) => { key: string; id: unknown; path: string };
	}
> = {
	task_created: {
		eventTypes: ['task.created'],
		enrich: (data) => ({ key: 'task', id: data.task_id, path: `/tasks/${id(data.task_id)}` }),
	},
	task_assigned: {
		// A task created already assigned sends only task.created.
		eventTypes: ['task.created', 'task.assigned'],
		enrich: (data) => ({ key: 'task', id: data.task_id, path: `/tasks/${id(data.task_id)}` }),
	},
	task_status_changed: {
		eventTypes: ['task.status_changed'],
		enrich: (data) => ({ key: 'task', id: data.task_id, path: `/tasks/${id(data.task_id)}` }),
	},
	review_completed: {
		eventTypes: ['review.completed'],
		enrich: (data) => ({
			key: 'review',
			id: data.review_id,
			path: `/reviews/${id(data.review_id)}`,
		}),
	},
	any_event: { eventTypes: [] },
};

function subscribedEventTypes(this: IHookFunctions | IWebhookFunctions): string[] {
	const trigger = this.getNodeParameter('event') as string;
	if (trigger === 'any_event') return this.getNodeParameter('eventTypes', []) as string[];
	return TRIGGERS[trigger].eventTypes;
}

function sameSet(a: string[], b: string[]): boolean {
	return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

function forget(staticData: IDataObject): void {
	delete staticData.endpointId;
	delete staticData.secret;
	delete staticData.userId;
}

/** Whether the trigger's own rules or filters drop this event. */
export function filteredOut(
	trigger: string,
	data: IDataObject,
	filters: IDataObject,
	eventType = '',
): boolean {
	if (trigger === 'task_status_changed' && filters.status && filters.status !== 'any') {
		return data.status !== filters.status;
	}
	if (trigger === 'task_assigned') {
		const assigned = Boolean(data.assignee_id || data.team_id || data.agent_id);
		if (eventType === 'task.created' && !assigned) return true;
		if (filters.onlyAssignedToMe) return !filters.userId || data.assignee_id !== filters.userId;
	}
	return false;
}

export class WordsmithTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Wordsmith Trigger',
		name: 'wordsmithTrigger',
		icon: {
			light: 'file:../Wordsmith/wordsmith.svg',
			dark: 'file:../Wordsmith/wordsmith.dark.svg',
		},
		group: ['trigger'],
		...NODE_VERSIONS,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow the moment something happens in Wordsmith',
		defaults: { name: 'Wordsmith Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: credentialsFor(),
		webhooks: [
			{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
		],
		properties: [
			...triggerAuthenticationProperties,
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				required: true,
				options: [
					{
						name: 'Any Wordsmith Event',
						value: 'any_event',
						description: 'Starts on the event types you choose',
					},
					{
						name: 'New Task',
						value: 'task_created',
						description: 'Starts when a task you can see is created',
					},
					{
						name: 'Review Completed',
						value: 'review_completed',
						description:
							'Starts when a review finishes, wherever it was started: the web app, Word or the API',
					},
					{
						name: 'Task Assigned',
						value: 'task_assigned',
						description:
							'Starts when a task is created already assigned, or gets a new assignee, team or agent',
					},
					{
						name: 'Task Status Changed',
						value: 'task_status_changed',
						description: 'Starts when a task’s status changes, for example to completed',
					},
				],
				default: 'task_created',
			},
			{
				displayName: 'Event Type Names or IDs',
				name: 'eventTypes',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getEventTypes' },
				required: true,
				default: [],
				description:
					'The events that start the workflow. A wildcard such as task.* covers every event of that resource. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { event: ['any_event'] } },
			},
			{
				displayName: 'New Status',
				name: 'status',
				type: 'options',
				options: STATUS_FILTERS,
				default: 'completed',
				displayOptions: { show: { event: ['task_status_changed'] } },
			},
			{
				displayName: 'Only Tasks Assigned to Me',
				name: 'onlyAssignedToMe',
				type: 'boolean',
				default: false,
				description: 'Whether to start only when the task is assigned to the credential’s user',
				displayOptions: { show: { event: ['task_assigned'] } },
			},
			{
				displayName:
					'Instant triggers are rolling out. If activating fails with a 404, use the Wordsmith Polling Trigger, or ask your Wordsmith contact. Your n8n must be reachable on a public https URL.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	methods = {
		loadOptions: { getEventTypes },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const endpointId = staticData.endpointId as string | undefined;
				if (!endpointId || !staticData.secret) return false;
				const response = await wordsmithRequest.call(
					this,
					'GET',
					`/webhook_endpoints/${id(endpointId)}`,
					{ allowStatus: [404] },
				);
				if (response.statusCode === 404) {
					forget(staticData);
					return false;
				}
				const endpoint = response.body as IDataObject;
				const matches =
					endpoint.url === this.getNodeWebhookUrl('default') &&
					endpoint.status === 'enabled' &&
					sameSet(endpoint.event_types as string[], subscribedEventTypes.call(this));
				if (!matches) {
					// A stale endpoint would keep sending the old events, and a disabled one sends nothing.
					await wordsmithRequest.call(this, 'DELETE', `/webhook_endpoints/${id(endpointId)}`, {
						allowStatus: [404],
					});
					forget(staticData);
				}
				return matches;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const eventTypes = subscribedEventTypes.call(this);
				if (eventTypes.length === 0) {
					throw new NodeOperationError(this.getNode(), 'Choose at least one event type');
				}
				const response = await wordsmithRequest.call(this, 'POST', '/webhook_endpoints', {
					body: {
						url: this.getNodeWebhookUrl('default'),
						event_types: eventTypes,
						description: `n8n: ${this.getWorkflow().name ?? String(this.getWorkflow().id)}`.slice(
							0,
							500,
						),
					},
					allowStatus: [404],
				});
				if (response.statusCode === 404) {
					throw new NodeOperationError(
						this.getNode(),
						'Instant triggers aren’t on for your organisation yet',
						{
							description:
								'Use the Wordsmith Polling Trigger instead, or ask your Wordsmith contact to turn on webhook endpoints.',
						},
					);
				}
				const endpoint = response.body as IDataObject;
				const staticData = this.getWorkflowStaticData('node');
				staticData.endpointId = endpoint.id;
				staticData.secret = endpoint.secret;
				if (this.getNodeParameter('event') === 'task_assigned') {
					staticData.userId = (await wordsmithApi.call(this, 'GET', '/me')).user_id;
				}
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const endpointId = staticData.endpointId as string | undefined;
				if (endpointId) {
					await wordsmithRequest.call(this, 'DELETE', `/webhook_endpoints/${id(endpointId)}`, {
						allowStatus: [404],
					});
				}
				forget(staticData);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const staticData = this.getWorkflowStaticData('node');
		const rawBody = request.rawBody
			? request.rawBody.toString('utf8')
			: JSON.stringify(request.body);
		const valid = verifySignature(
			rawBody,
			this.getHeaderData()['wordsmith-signature'],
			String(staticData.secret ?? ''),
			Math.floor(Date.now() / 1000),
		);
		if (!valid) {
			const response = this.getResponseObject();
			response.status(401).send('Invalid Wordsmith signature').end();
			return { noWebhookResponse: true };
		}

		const event = this.getBodyData();
		const trigger = this.getNodeParameter('event') as string;
		const seen = (staticData.seenEventIds as string[] | undefined) ?? [];
		if (event.type === TEST_EVENT || seen.includes(String(event.id))) {
			return { webhookResponse: 'OK' };
		}
		staticData.seenEventIds = [...seen, String(event.id)].slice(-SEEN_EVENTS_KEPT);

		const data = (event.data ?? {}) as IDataObject;
		const filters: IDataObject = {
			status: this.getNodeParameter('status', 'completed'),
			onlyAssignedToMe: this.getNodeParameter('onlyAssignedToMe', false),
			userId: staticData.userId,
		};
		if (filteredOut(trigger, data, filters, String(event.type))) return { webhookResponse: 'OK' };

		const meta = {
			event_id: event.id,
			event_type: event.type,
			event_created_at: event.created_at,
			actor_kind: (event.actor as IDataObject | undefined)?.kind ?? null,
		};
		const enrich = TRIGGERS[trigger]?.enrich?.(data);
		if (!enrich) {
			return { workflowData: [this.helpers.returnJsonArray({ event, ...meta })] };
		}
		const response = await wordsmithRequest.call(this, 'GET', enrich.path, { allowStatus: [404] });
		if (response.statusCode === 404) {
			// Fails the execution so it shows in n8n and error workflows run, rather than dropping the event.
			throw new NodeApiError(
				this.getNode(),
				{ ...((response.body ?? {}) as JsonObject), httpCode: '404' },
				{
					httpCode: '404',
					message: `Wordsmith could not read ${enrich.key} ${String(enrich.id)}: it was deleted, or this connection lost access`,
					description: `Event ${String(event.id)} (${String(event.type)}).`,
				},
			);
		}
		const output: IDataObject = { [enrich.key]: response.body as IDataObject, ...meta };
		if (trigger === 'task_status_changed') {
			output.previous_status = data.previous_status ?? null;
			output.status = data.status ?? null;
		}
		if (trigger === 'review_completed') {
			output.findings = data.findings ?? null;
			output.redline_file_id = data.redline_file_id ?? null;
		}
		return { workflowData: [this.helpers.returnJsonArray(output)] };
	}
}
