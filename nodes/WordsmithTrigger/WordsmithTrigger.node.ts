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
import type { RawResponse } from '../shared/transport';
import {
	TRIGGER_VERSIONS,
	SIGN_IN_CREDENTIAL,
	triggerAuthenticationProperties,
	credentialName,
	credentialsFor,
	id,
	toNodeApiError,
	wordsmithApi,
	wordsmithRequest,
} from '../shared/transport';

const TEST_EVENT = 'webhook_endpoint.test';
const STATUS_FILTERS = [{ name: 'Any Status', value: 'any' }, ...TASK_STATUSES];
const SEEN_EVENTS_KEPT = 200;
const FLOW_FIELD_LENGTH = 200;
const INPUT_REQUEST_FIELDS = ['input_request_id', 'session_id', 'task_id', 'kind', 'status', 'url'];
/** The operation types of the public API, for Background Job Finished's filter. */
export const JOB_TYPES = [
	{ name: 'Document Action', value: 'document_action' },
	{ name: 'Draft', value: 'draft' },
	{ name: 'Playbook Generation', value: 'playbook_generation' },
	{ name: 'Question', value: 'question' },
	{ name: 'Redlined Review Copy', value: 'review_redline' },
	{ name: 'Report Export', value: 'report_export' },
	{ name: 'Report Import', value: 'report_import' },
	{ name: 'Report Run', value: 'report_run' },
	{ name: 'Repository Indexing', value: 'repository_indexing' },
	{ name: 'Research Report', value: 'research_report' },
	{ name: 'Review', value: 'review' },
	{ name: 'Review Decisions', value: 'review_decisions' },
];

/** A read that turns an event into its resource. `find` picks the item with that id from a list response. */
export interface TriggerRead {
	key: string;
	id: unknown;
	path: string;
	find?: unknown;
}

/**
 * The event types each trigger subscribes to, the resources an event already carries, the reads that turn an event
 * into its resources, and the event fields it outputs as they are. A trigger with no carries, reads or fields
 * outputs the whole event.
 */
export const TRIGGERS: Record<
	string,
	{
		eventTypes: string[];
		/** The resources the event's data already holds, so no read is needed. */
		carries?: (data: IDataObject) => IDataObject | undefined;
		reads?: (data: IDataObject) => TriggerRead[];
		fields?: string[];
	}
> = {
	task_created: {
		eventTypes: ['task.created'],
		reads: (data) => [readTask(data)],
	},
	task_assigned: {
		// A task created already assigned sends only task.created.
		eventTypes: ['task.created', 'task.assigned'],
		reads: (data) => [readTask(data)],
	},
	task_status_changed: {
		eventTypes: ['task.status_changed'],
		reads: (data) => [readTask(data)],
		fields: ['previous_status', 'status'],
	},
	task_comment_added: {
		eventTypes: ['task.comment_added'],
		reads: (data) => [
			readTask(data),
			{
				key: 'comment',
				id: data.comment_id,
				path: `/tasks/${id(data.task_id)}/comments`,
				find: data.comment_id,
			},
		],
	},
	review_completed: {
		eventTypes: ['review.completed'],
		reads: (data) => [
			{ key: 'review', id: data.review_id, path: `/reviews/${id(data.review_id)}` },
		],
		fields: ['findings', 'redline_file_id'],
	},
	// The public API cannot read an input request yet, so these output the event's fields and the link to it.
	agent_waiting_for_input: { eventTypes: ['input_request.created'], fields: INPUT_REQUEST_FIELDS },
	agent_input_resolved: { eventTypes: ['input_request.resolved'], fields: INPUT_REQUEST_FIELDS },
	repository_documents_added: {
		eventTypes: ['repository.documents_added'],
		reads: (data) => [readRepository(data)],
		fields: ['document_ids', 'count'],
	},
	repository_indexing_completed: {
		eventTypes: ['repository.indexing_completed'],
		reads: (data) => [readRepository(data)],
		fields: ['indexed', 'failed'],
	},
	report_run_completed: {
		eventTypes: ['report.run_completed'],
		reads: (data) => [
			{ key: 'report', id: data.report_id, path: `/reports/${id(data.report_id)}` },
		],
		fields: ['run_id', 'status'],
	},
	job_finished: {
		eventTypes: ['operation.succeeded', 'operation.failed', 'operation.cancelled'],
		// The event's data is the whole operation: Wordsmith delivers operation events only while the operation exists.
		carries: (data) => ({ operation: data }),
	},
	any_event: { eventTypes: [] },
};

function readTask(data: IDataObject): TriggerRead {
	return { key: 'task', id: data.task_id, path: `/tasks/${id(data.task_id)}` };
}

function readRepository(data: IDataObject): TriggerRead {
	return {
		key: 'repository',
		id: data.repository_id,
		path: `/repositories/${id(data.repository_id)}`,
	};
}

/** The `integration` object that puts the endpoint under the integration limits and names the workflow. */
export function integrationFor(workflow: { id?: unknown; name?: unknown }): IDataObject {
	const integration: IDataObject = { platform: 'n8n' };
	if (workflow.id !== undefined && workflow.id !== null && String(workflow.id) !== '') {
		integration.flow_id = String(workflow.id).slice(0, FLOW_FIELD_LENGTH);
	}
	if (typeof workflow.name === 'string' && workflow.name.trim()) {
		integration.flow_name = workflow.name.trim().slice(0, FLOW_FIELD_LENGTH);
	}
	return integration;
}

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
	if (trigger === 'job_finished' && filters.jobType && filters.jobType !== 'any') {
		return data.type !== filters.jobType;
	}
	return false;
}

/**
 * Reads one resource an event names. A 404, or a list without the item, fails the execution so it shows in n8n and
 * error workflows run, rather than dropping the event.
 */
async function readResource(
	this: IWebhookFunctions,
	read: TriggerRead,
	event: IDataObject,
): Promise<IDataObject> {
	const response = await wordsmithRequest.call(this, 'GET', read.path, { allowStatus: [404] });
	const message = `Wordsmith could not read ${read.key} ${String(read.id)}: it was deleted, or this connection lost access`;
	const description = `Event ${String(event.id)} (${String(event.type)}).`;
	if (response.statusCode === 404) {
		throw new NodeApiError(
			this.getNode(),
			{ ...((response.body ?? {}) as JsonObject), httpCode: '404' },
			{ httpCode: '404', message, description },
		);
	}
	if (read.find === undefined) return response.body as IDataObject;
	const found = (Array.isArray(response.body) ? (response.body as IDataObject[]) : []).find(
		(item) => item.id === read.find,
	);
	if (found) return found;
	// The list itself was read, so the error names only the ids, not the other items.
	throw new NodeOperationError(this.getNode(), message, { description });
}

/**
 * The error for a refused subscribe. On OAuth2 a missing scope usually means the grant predates the webhook
 * scopes, so the fix is to reconnect; the API's own text names the scope.
 */
function webhookAccessError(this: IHookFunctions, response: RawResponse): NodeApiError {
	const body = (response.body ?? {}) as IDataObject;
	if (body.error !== 'insufficient_scope' || credentialName.call(this) !== SIGN_IN_CREDENTIAL) {
		return toNodeApiError.call(this, response);
	}
	const missing =
		typeof body.error_description === 'string'
			? `${body.error_description.trim().replace(/\.+$/, '')}. `
			: '';
	return new NodeApiError(
		this.getNode(),
		{ ...(body as JsonObject), httpCode: '403' },
		{
			httpCode: '403',
			message: 'This Wordsmith connection lacks a scope the trigger needs',
			description: `${missing}Open the Wordsmith OAuth2 API credential and select Connect my account to approve it. A connection made before Wordsmith offered the webhook scopes needs this once. If your role doesn’t allow webhook endpoints, Wordsmith grants everything else: use the Wordsmith Polling Trigger instead.`,
		},
	);
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
		...TRIGGER_VERSIONS,
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
						name: 'Agent Input Answered',
						value: 'agent_input_resolved',
						description:
							'Starts when a person answers an agent that was waiting for them, or the request is cancelled',
					},
					{
						name: 'Agent Waiting for Input',
						value: 'agent_waiting_for_input',
						description: 'Starts when an agent stops to wait for a person, such as an approval',
					},
					{
						name: 'Any Wordsmith Event',
						value: 'any_event',
						description: 'Starts on the event types you choose',
					},
					{
						name: 'Background Job Finished',
						value: 'job_finished',
						description:
							'Starts when a review, draft, document action or other job you started finishes, for work longer than Wait for Result should hold a step',
					},
					{
						name: 'Documents Added to a Repository',
						value: 'repository_documents_added',
						description: 'Starts when documents are added to a repository',
					},
					{
						name: 'New Task',
						value: 'task_created',
						description: 'Starts when a task you can see is created',
					},
					{
						name: 'New Task Comment',
						value: 'task_comment_added',
						description:
							'Starts when someone comments on a task you can see, or replies to a comment',
					},
					{
						name: 'Report Run Finished',
						value: 'report_run_completed',
						description: 'Starts when a report run finishes',
					},
					{
						name: 'Repository Indexing Finished',
						value: 'repository_indexing_completed',
						description: 'Starts when a repository has finished indexing its documents',
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
				displayName: 'Job Type',
				name: 'jobType',
				type: 'options',
				options: [{ name: 'Any Job Type', value: 'any' }, ...JOB_TYPES],
				default: 'any',
				displayOptions: { show: { event: ['job_finished'] } },
			},
			{
				displayName:
					'Your n8n must be reachable on a public https URL. Each active workflow with this trigger holds one Wordsmith webhook endpoint, up to 100 per user.',
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
					// null, not absent: an endpoint made before n8n sent `integration` counts against the lower limit.
					endpoint.integration !== null &&
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
				const workflow = this.getWorkflow();
				const response = await wordsmithRequest.call(this, 'POST', '/webhook_endpoints', {
					body: {
						url: this.getNodeWebhookUrl('default'),
						event_types: eventTypes,
						description: `n8n: ${workflow.name ?? String(workflow.id)}`.slice(0, 500),
						integration: integrationFor(workflow),
					},
					allowStatus: [403, 404],
				});
				if (response.statusCode === 403) throw webhookAccessError.call(this, response);
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
			jobType: this.getNodeParameter('jobType', 'any'),
		};
		if (filteredOut(trigger, data, filters, String(event.type))) return { webhookResponse: 'OK' };

		const meta = {
			event_id: event.id,
			event_type: event.type,
			event_created_at: event.created_at,
			actor_kind: (event.actor as IDataObject | undefined)?.kind ?? null,
		};
		const spec = TRIGGERS[trigger];
		if (!spec?.carries && !spec?.reads && !spec?.fields) {
			return { workflowData: [this.helpers.returnJsonArray({ event, ...meta })] };
		}
		const output: IDataObject = { ...spec.carries?.(data) };
		for (const read of spec.reads?.(data) ?? []) {
			output[read.key] = await readResource.call(this, read, event);
		}
		for (const field of spec.fields ?? []) output[field] = data[field] ?? null;
		Object.assign(output, meta);
		return { workflowData: [this.helpers.returnJsonArray(output)] };
	}
}
