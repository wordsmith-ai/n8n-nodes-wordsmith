import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
	WordsmithTrigger,
	filteredOut,
	integrationFor,
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
			integration: { platform: 'n8n', flow_id: 'wf1', flow_name: 'Matter intake' },
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

	it('names the workflow in the integration object, within the API’s lengths', () => {
		assert.deepEqual(integrationFor({ id: 'wf1', name: '  Intake  ' }), {
			platform: 'n8n',
			flow_id: 'wf1',
			flow_name: 'Intake',
		});
		assert.deepEqual(integrationFor({ id: undefined, name: '' }), { platform: 'n8n' });
		assert.equal(integrationFor({ id: 'wf1', name: 'x'.repeat(300) }).flow_name.length, 200);
	});

	it('gives an OAuth2 scope refusal its own error, and leaves other 403s to the API’s message', async () => {
		const apiText = 'This needs the webhooks:write scope. Reconnect the app and approve it.';
		const refused = () => ok({ error: 'insufficient_scope', error_description: apiText }, 403);
		const oauth = context({ parameters: { authentication: 'oAuth2' }, respond: refused });
		await assert.rejects(methods.create.call(oauth), (error) => {
			assert.equal(error.httpCode, '403');
			assert.notEqual(error.message, apiText);
			assert.ok(error.description.startsWith(apiText));
			assert.ok(!error.description.includes('..'));
			return true;
		});

		// An API key, or a 403 that is not a missing scope, shows the API's own message.
		const apiKey = context({ respond: refused });
		await assert.rejects(methods.create.call(apiKey), { httpCode: '403', message: apiText });
		const roleText = 'Your role cannot create webhook endpoints.';
		const role = context({
			parameters: { authentication: 'oAuth2' },
			respond: () => ok({ message: roleText, error_code: 'forbidden' }, 403),
		});
		await assert.rejects(methods.create.call(role), { httpCode: '403', message: roleText });
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

	it('replaces an endpoint made before n8n sent the integration object', async () => {
		const ctx = context({
			staticData: { endpointId: 'we_1', secret: 'whsec_1' },
			respond: (options) =>
				options.method === 'GET'
					? ok({
							id: 'we_1',
							url: WEBHOOK_URL,
							status: 'enabled',
							event_types: ['task.created'],
							integration: null,
						})
					: ok(null, 204),
		});
		assert.equal(await methods.checkExists.call(ctx), false);
		assert.deepEqual(
			ctx.calls.map((c) => c.method),
			['GET', 'DELETE'],
		);
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

	it('reads the task and the comment for a new comment', async () => {
		const body = event('task.comment_added', { task_id: 't1', comment_id: 'c2', url: 'u' });
		const ctx = webhookContext({
			body,
			parameters: { event: 'task_comment_added' },
			sign: signedWith('whsec_1'),
			respond: (options) =>
				options.url.endsWith('/comments')
					? ok([
							{ id: 'c1', content: 'older' },
							{ id: 'c2', content: 'Please review', parent_comment_id: 'c1' },
						])
					: ok({ id: 't1', title: 'NDA' }),
		});
		const result = await trigger.webhook.call(ctx);
		assert.deepEqual(
			ctx.calls.map((c) => c.url),
			[`${API}/tasks/t1`, `${API}/tasks/t1/comments`],
		);
		const json = result.workflowData[0][0].json;
		assert.deepEqual(json.task, { id: 't1', title: 'NDA' });
		assert.deepEqual(json.comment, { id: 'c2', content: 'Please review', parent_comment_id: 'c1' });
	});

	it('fails the execution when the comment is gone', async () => {
		const ctx = webhookContext({
			body: event('task.comment_added', { task_id: 't1', comment_id: 'c9' }),
			parameters: { event: 'task_comment_added' },
			sign: signedWith('whsec_1'),
			respond: (options) =>
				options.url.endsWith('/comments')
					? ok([{ id: 'c1', content: 'Another comment' }])
					: ok({ id: 't1' }),
		});
		await assert.rejects(trigger.webhook.call(ctx), (error) => {
			assert.equal(error.name, 'NodeOperationError');
			assert.match(error.message, /comment c9/);
			// The error names the missing comment only, never the other comments it read.
			assert.ok(!JSON.stringify(error).includes('Another comment'));
			return true;
		});
	});

	it('outputs an input request’s fields and link without reading anything', async () => {
		const data = {
			input_request_id: 'ir1',
			session_id: 's1',
			task_id: null,
			kind: 'approval',
			status: 'pending',
			url: 'https://app.wordsmith.ai/input-requests/ir1',
		};
		const body = event('input_request.created', data);
		const ctx = webhookContext({
			body,
			parameters: { event: 'agent_waiting_for_input' },
			sign: signedWith('whsec_1'),
		});
		const result = await trigger.webhook.call(ctx);
		assert.equal(ctx.calls.length, 0);
		assert.deepEqual(result.workflowData[0][0].json, {
			...data,
			event_id: body.id,
			event_type: 'input_request.created',
			event_created_at: '2026-11-12T10:00:00Z',
			actor_kind: 'user',
		});
	});

	it('reads the repository or report and keeps the event’s counts', async () => {
		const added = webhookContext({
			body: event('repository.documents_added', {
				repository_id: 'rp1',
				document_ids: ['d1', 'd2'],
				count: 2,
			}),
			parameters: { event: 'repository_documents_added' },
			sign: signedWith('whsec_1'),
			respond: () => ok({ id: 'rp1', name: 'Precedents' }),
		});
		const repository = (await trigger.webhook.call(added)).workflowData[0][0].json;
		assert.equal(added.calls[0].url, `${API}/repositories/rp1`);
		assert.deepEqual(repository.repository, { id: 'rp1', name: 'Precedents' });
		assert.deepEqual(repository.document_ids, ['d1', 'd2']);
		assert.equal(repository.count, 2);

		const run = webhookContext({
			body: event('report.run_completed', {
				report_id: 'rep1',
				run_id: 'run1',
				status: 'succeeded',
			}),
			parameters: { event: 'report_run_completed' },
			sign: signedWith('whsec_1'),
			respond: () => ok({ id: 'rep1', name: 'NDA tracker' }),
		});
		const report = (await trigger.webhook.call(run)).workflowData[0][0].json;
		assert.equal(run.calls[0].url, `${API}/reports/rep1`);
		assert.equal(report.run_id, 'run1');
		assert.equal(report.status, 'succeeded');
	});

	it('outputs the finished job the event carries, and skips other job types', async () => {
		// As delivered: the event's data is the whole operation.
		const operation = (type) => ({
			id: 'op1',
			type,
			status: 'succeeded',
			resource: { type: 'repository', id: 'rp1' },
			result: { indexed: 1, failed: 0 },
		});
		const finished = (jobType, type) =>
			webhookContext({
				body: event('operation.succeeded', operation(type)),
				parameters: { event: 'job_finished', jobType },
				sign: signedWith('whsec_1'),
				respond: () => ok({}),
			});
		const indexing = finished('repository_indexing', 'repository_indexing');
		const result = await trigger.webhook.call(indexing);
		assert.equal(indexing.calls.length, 0);
		assert.deepEqual(result.workflowData[0][0].json.operation, operation('repository_indexing'));
		const draft = finished('review', 'draft');
		assert.equal((await trigger.webhook.call(draft)).workflowData, undefined);
		const any = finished('any', 'draft');
		assert.ok((await trigger.webhook.call(any)).workflowData);
	});

	it('fails the execution with the API’s text when an OAuth2 read lacks a scope', async () => {
		const apiText = 'This needs the reports:read scope. Reconnect the app and approve it.';
		const ctx = webhookContext({
			body: event('report.run_completed', {
				report_id: 'rep1',
				run_id: 'run1',
				status: 'succeeded',
			}),
			parameters: { event: 'report_run_completed', authentication: 'oAuth2' },
			sign: signedWith('whsec_1'),
			respond: () => ok({ error: 'insufficient_scope', error_description: apiText }, 403),
		});
		await assert.rejects(trigger.webhook.call(ctx), { httpCode: '403', message: apiText });
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
