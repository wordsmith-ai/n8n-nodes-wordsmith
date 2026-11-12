import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
	WordsmithTrigger,
	filteredOut,
} = require('../dist/nodes/WordsmithTrigger/WordsmithTrigger.node.js');

const WEBHOOK_URL = 'https://n8n.example.com/webhook/abc/webhook';
const CREDENTIALS = { region: 'custom', baseUrl: 'https://staging.api.wordsmith.ai', apiKey: 'k' };
const API = 'https://staging.api.wordsmith.ai/api/v1';

const ok = (body, statusCode = 200) => ({ statusCode, headers: {}, body });

function context({ parameters = {}, staticData = {}, respond }) {
	const calls = [];
	const values = {
		event: 'task_created',
		status: 'completed',
		onlyAssignedToMe: false,
		...parameters,
	};
	return {
		calls,
		staticData,
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, fallback) => (name in values ? values[name] : fallback),
		getNodeWebhookUrl: () => WEBHOOK_URL,
		getWorkflow: () => ({ id: 'wf1', name: 'Matter intake' }),
		getNode: () => ({ name: 'Wordsmith Trigger', type: 'wordsmithTrigger', typeVersion: 1 }),
		getCredentials: async () => CREDENTIALS,
		helpers: {
			httpRequestWithAuthentication: async (_name, options) => {
				calls.push({
					method: options.method,
					url: options.url,
					body: options.body,
					headers: options.headers,
				});
				return respond(options);
			},
			returnJsonArray: (data) => (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
		},
	};
}

const methods = new WordsmithTrigger().webhookMethods.default;

describe('Wordsmith Trigger lifecycle', () => {
	it('subscribes the trigger’s event types and keeps the endpoint id and secret', async () => {
		const ctx = context({ respond: () => ok({ id: 'we_1', secret: 'whsec_1' }, 201) });
		assert.equal(await methods.create.call(ctx), true);
		assert.equal(ctx.calls[0].url, `${API}/webhook_endpoints`);
		assert.deepEqual(ctx.calls[0].body, {
			url: WEBHOOK_URL,
			event_types: ['task.created'],
			description: 'n8n: Matter intake',
		});
		assert.equal(ctx.calls[0].headers['Wordsmith-Integration'].startsWith('n8n/'), true);
		assert.deepEqual(ctx.staticData, { endpointId: 'we_1', secret: 'whsec_1' });
	});

	it('subscribes the chosen types for Any Wordsmith Event', async () => {
		const ctx = context({
			parameters: { event: 'any_event', eventTypes: ['task.*', 'review.completed'] },
			respond: () => ok({ id: 'we_1', secret: 'whsec_1' }, 201),
		});
		await methods.create.call(ctx);
		assert.deepEqual(ctx.calls[0].body.event_types, ['task.*', 'review.completed']);
	});

	it('explains a 404 as the rollout gate', async () => {
		const ctx = context({ respond: () => ok({ error_code: 'not_found' }, 404) });
		await assert.rejects(methods.create.call(ctx), { name: 'NodeOperationError' });
		assert.deepEqual(ctx.staticData, {});
	});

	it('keeps an endpoint with the same URL and events', async () => {
		const ctx = context({
			staticData: { endpointId: 'we_1', secret: 'whsec_1' },
			respond: () =>
				ok({ id: 'we_1', url: WEBHOOK_URL, status: 'enabled', event_types: ['task.created'] }),
		});
		assert.equal(await methods.checkExists.call(ctx), true);
		assert.equal(ctx.calls.length, 1);
	});

	it('replaces an endpoint whose events changed', async () => {
		const ctx = context({
			parameters: { event: 'review_completed' },
			staticData: { endpointId: 'we_1', secret: 'whsec_1' },
			respond: (options) =>
				options.method === 'GET'
					? ok({ id: 'we_1', url: WEBHOOK_URL, status: 'enabled', event_types: ['task.created'] })
					: ok(null, 204),
		});
		assert.equal(await methods.checkExists.call(ctx), false);
		assert.deepEqual(
			ctx.calls.map((c) => c.method),
			['GET', 'DELETE'],
		);
		assert.deepEqual(ctx.staticData, {});
	});

	it('treats an endpoint Wordsmith no longer has as gone, on check and on delete', async () => {
		const gone = () => ok({ error_code: 'not_found' }, 404);
		const check = context({ staticData: { endpointId: 'we_x', secret: 's' }, respond: gone });
		assert.equal(await methods.checkExists.call(check), false);
		const remove = context({ staticData: { endpointId: 'we_x', secret: 's' }, respond: gone });
		assert.equal(await methods.delete.call(remove), true);
		assert.deepEqual(remove.staticData, {});
	});
});

function webhookContext({
	body,
	sign,
	parameters,
	respond = () => ok({ id: 't1', title: 'NDA' }),
}) {
	const raw = JSON.stringify(body);
	const ctx = context({
		parameters,
		staticData: { endpointId: 'we_1', secret: 'whsec_1' },
		respond,
	});
	const response = {};
	return Object.assign(ctx, {
		response,
		getRequestObject: () => ({ rawBody: Buffer.from(raw), body }),
		getHeaderData: () => ({ 'wordsmith-signature': sign?.(raw) }),
		getBodyData: () => body,
		getResponseObject: () => ({
			status(code) {
				response.statusCode = code;
				return this;
			},
			send() {
				return this;
			},
			end() {},
		}),
	});
}

const signedWith = (secret) => (raw) => {
	const t = Math.floor(Date.now() / 1000);
	return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
};

const event = (type, data) => ({
	id: `evt_${Math.random()}`,
	type,
	created_at: '2026-11-12T10:00:00Z',
	actor: { kind: 'user', id: 'u1' },
	data,
});

describe('Wordsmith Trigger webhook', () => {
	const trigger = new WordsmithTrigger();

	it('reads the task and starts the workflow with it', async () => {
		const body = event('task.created', { task_id: 't1' });
		const ctx = webhookContext({ body, sign: signedWith('whsec_1') });
		const result = await trigger.webhook.call(ctx);
		assert.equal(ctx.calls[0].url, `${API}/tasks/t1`);
		assert.deepEqual(result.workflowData[0][0].json, {
			task: { id: 't1', title: 'NDA' },
			event_id: body.id,
			event_type: 'task.created',
			event_created_at: '2026-11-12T10:00:00Z',
			actor_kind: 'user',
		});
	});

	it('answers 401 and starts nothing for a bad signature', async () => {
		const ctx = webhookContext({ body: event('task.created', {}), sign: signedWith('wrong') });
		assert.deepEqual(await trigger.webhook.call(ctx), { noWebhookResponse: true });
		assert.equal(ctx.response.statusCode, 401);
	});

	it('drops the test event and repeats of an event', async () => {
		const test = webhookContext({
			body: event('webhook_endpoint.test', {}),
			sign: signedWith('whsec_1'),
		});
		assert.equal((await trigger.webhook.call(test)).workflowData, undefined);

		const body = event('task.created', { task_id: 't1' });
		const first = webhookContext({ body, sign: signedWith('whsec_1') });
		await trigger.webhook.call(first);
		const again = webhookContext({ body, sign: signedWith('whsec_1') });
		again.staticData.seenEventIds = first.staticData.seenEventIds;
		assert.equal((await trigger.webhook.call(again)).workflowData, undefined);
	});

	it('fails the execution for an event whose resource the user can no longer read', async () => {
		const ctx = webhookContext({
			body: event('task.created', { task_id: 't1' }),
			sign: signedWith('whsec_1'),
			respond: () => ok({ error_code: 'not_found' }, 404),
		});
		await assert.rejects(trigger.webhook.call(ctx), { name: 'NodeApiError', httpCode: '404' });
	});
});

describe('trigger filters', () => {
	it('match a status change to the chosen status', () => {
		assert.equal(
			filteredOut('task_status_changed', { status: 'completed' }, { status: 'completed' }),
			false,
		);
		assert.equal(
			filteredOut('task_status_changed', { status: 'cancelled' }, { status: 'completed' }),
			true,
		);
		assert.equal(
			filteredOut('task_status_changed', { status: 'cancelled' }, { status: 'any' }),
			false,
		);
	});

	it('keep a task.created for Task assigned only when the task arrived assigned', () => {
		const none = {};
		assert.equal(filteredOut('task_assigned', {}, none, 'task.created'), true);
		assert.equal(filteredOut('task_assigned', { agent_id: 'a1' }, none, 'task.created'), false);
		assert.equal(filteredOut('task_assigned', { team_id: 't1' }, none, 'task.created'), false);
		assert.equal(filteredOut('task_assigned', {}, none, 'task.assigned'), false);
		const mine = { onlyAssignedToMe: true, userId: 'u1' };
		assert.equal(filteredOut('task_assigned', { assignee_id: 'u1' }, mine, 'task.created'), false);
		assert.equal(filteredOut('task_assigned', { assignee_id: 'u2' }, mine, 'task.created'), true);
	});

	it('keep only assignments to the credential’s user when asked', () => {
		const mine = { onlyAssignedToMe: true, userId: 'u1' };
		assert.equal(filteredOut('task_assigned', { assignee_id: 'u1' }, mine), false);
		assert.equal(filteredOut('task_assigned', { assignee_id: 'u2' }, mine), true);
		assert.equal(
			filteredOut('task_assigned', { assignee_id: 'u2' }, { onlyAssignedToMe: false }),
			false,
		);
	});
});
