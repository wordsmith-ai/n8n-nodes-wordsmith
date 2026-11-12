import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const transport = require('../dist/nodes/shared/transport.js');
const {
	waitForOperation,
	waitForQuestion,
	idempotencyKey,
} = require('../dist/nodes/shared/waiting.js');
const { verifySignature } = require('../dist/nodes/shared/signature.js');
const { placeholderFields } = require('../dist/nodes/shared/methods.js');

function clock() {
	let now = 0;
	const sleeps = [];
	return {
		sleeps,
		advance: (ms) => (now += ms),
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
	};
}

describe('apiBaseUrl', () => {
	it('maps the region to its host and defaults to Europe', () => {
		assert.equal(transport.apiBaseUrl({ region: 'eu' }), 'https://api.wordsmith.ai/api/v1');
		assert.equal(transport.apiBaseUrl({ region: 'us' }), 'https://api.us.wordsmith.ai/api/v1');
		assert.equal(transport.apiBaseUrl({}), 'https://api.wordsmith.ai/api/v1');
		assert.equal(
			transport.apiBaseUrl({ region: 'custom', baseUrl: 'https://staging.api.wordsmith.ai//' }),
			'https://staging.api.wordsmith.ai/api/v1',
		);
	});

	it('refuses a custom host that is not https on wordsmith.ai', () => {
		for (const baseUrl of [
			'',
			'http://staging.api.wordsmith.ai',
			'https://evil.example.com',
			'https://wordsmith.ai.evil.com',
			'https://user:pass@api.wordsmith.ai',
		]) {
			assert.throws(() => transport.apiBaseUrl({ region: 'custom', baseUrl }), Error, baseUrl);
		}
		assert.equal(
			transport.apiBaseUrl({
				region: 'custom',
				baseUrl: 'https://staging.api.us.wordsmith.ai/path',
			}),
			'https://staging.api.us.wordsmith.ai/api/v1',
		);
	});
});

describe('errors and retries', () => {
	it('retries only 429, 503 and the two retryable 409s', () => {
		const retryable = (statusCode, error_code) =>
			transport.isRetryable({ statusCode, headers: {}, body: { error_code } });
		assert.equal(retryable(429), true);
		assert.equal(retryable(503), true);
		assert.equal(retryable(409, 'scan_in_progress'), true);
		assert.equal(retryable(409, 'upload_completion_in_progress'), true);
		assert.equal(retryable(409, 'conflict'), false);
		assert.equal(retryable(400), false);
		assert.equal(retryable(500), false);
	});

	it('shows the API message with its error code, and asks to reconnect on 401', () => {
		assert.deepEqual(
			transport.errorMessage({
				statusCode: 403,
				headers: {},
				body: { error_code: 'insufficient_scope', message: 'This key lacks reviews:write.' },
			}),
			{ message: 'This key lacks reviews:write.', description: 'Error code: insufficient_scope' },
		);
		// A refused key gets the step's own reconnect guidance, not the API's message.
		const refused = transport.errorMessage({
			statusCode: 401,
			headers: {},
			body: { error_code: 'unauthorized', message: 'Invalid API key' },
		});
		assert.notEqual(refused.message, 'Invalid API key');
		assert.equal(typeof refused.description, 'string');
	});

	it('keeps Retry-After between 1 and 60 seconds', () => {
		assert.equal(transport.retryAfterSeconds('10'), 10);
		assert.equal(transport.retryAfterSeconds('0.2'), 1);
		assert.equal(transport.retryAfterSeconds('3600'), 60);
		assert.equal(transport.retryAfterSeconds(undefined, 3), 3);
	});
});

describe('taskRef', () => {
	it('sends a task number without its #', () => {
		assert.equal(transport.taskRef(' #82 '), '82');
		assert.equal(
			transport.taskRef('5f0c9a12-8e3b-4d71-a6c4-0b2e9f7d3c58'),
			'5f0c9a12-8e3b-4d71-a6c4-0b2e9f7d3c58',
		);
	});
});

describe('the attribution header', () => {
	it('names the package version', () => {
		const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
		assert.equal(transport.PACKAGE_VERSION, version);
		assert.deepEqual(transport.INTEGRATION_HEADER, { 'Wordsmith-Integration': `n8n/${version}` });
	});
});

describe('waitForOperation', () => {
	it('long-polls until the operation ends', async () => {
		const time = clock();
		const calls = [];
		const states = ['running', 'succeeded'];
		const result = await waitForOperation(
			{ id: 'op1', status: 'queued' },
			900,
			async (operationId, waitSeconds) => {
				calls.push([operationId, waitSeconds]);
				time.advance(waitSeconds * 1000);
				return { id: operationId, status: states.shift(), poll_after_seconds: 5 };
			},
			time,
		);
		assert.deepEqual(result, {
			done: true,
			value: { id: 'op1', status: 'succeeded', poll_after_seconds: 5 },
		});
		assert.deepEqual(calls, [
			['op1', 20],
			['op1', 20],
		]);
		assert.deepEqual(time.sleeps, []);
	});

	it('sleeps poll_after_seconds when a long-poll answers early', async () => {
		const time = clock();
		const states = ['running', 'running', 'succeeded'];
		await waitForOperation(
			{ id: 'op1', status: 'running' },
			900,
			async (operationId) => ({ id: operationId, status: states.shift(), poll_after_seconds: 7 }),
			time,
		);
		assert.deepEqual(time.sleeps, [7000, 7000]);
	});

	it('stops at the deadline with the running operation', async () => {
		const time = clock();
		const result = await waitForOperation(
			{ id: 'op1', status: 'running' },
			60,
			async (operationId, waitSeconds) => {
				time.advance(waitSeconds * 1000);
				return { id: operationId, status: 'running' };
			},
			time,
		);
		assert.equal(result.done, false);
		assert.equal(result.value.id, 'op1');
	});

	it('returns a failed operation as done, for the caller to report', async () => {
		const result = await waitForOperation(
			{ id: 'op1', status: 'running' },
			60,
			async () => ({ id: 'op1', status: 'failed', error: { message: 'Bad file' } }),
			clock(),
		);
		assert.equal(result.done, true);
		assert.equal(result.value.status, 'failed');
	});
});

describe('waitForQuestion', () => {
	it('reads the question until it leaves in_progress', async () => {
		const time = clock();
		const states = ['in_progress', 'completed'];
		const result = await waitForQuestion(
			{ id: 'q1', status: 'in_progress' },
			60,
			async () => ({ id: 'q1', status: states.shift() }),
			time,
		);
		assert.equal(result.value.status, 'completed');
		assert.deepEqual(time.sleeps, [5000, 5000]);
	});
});

describe('idempotencyKey', () => {
	it('is stable for an execution, node, run and item, and fits the header limit', () => {
		assert.equal(idempotencyKey('41', 'Review', 0, 2), 'n8n:41:Review:0:2');
		// Each pass through a loop is a new run of the node, so it starts new work.
		assert.notEqual(idempotencyKey('41', 'Review', 1, 2), idempotencyKey('41', 'Review', 0, 2));
		assert.equal(idempotencyKey('41', 'x'.repeat(400), 0, 0).length, 255);
	});
});

describe('verifySignature', () => {
	const secret = 'whsec_test';
	const body = '{"id":"evt_1","type":"task.created"}';
	const sign = (t, payload = body, key = secret) =>
		createHmac('sha256', key).update(`${t}.${payload}`).digest('hex');

	it('accepts a fresh signature, and any v1 while a secret rotates', () => {
		assert.equal(verifySignature(body, `t=1000,v1=${sign(1000)}`, secret, 1030), true);
		assert.equal(
			verifySignature(body, `t=1000,v1=${sign(1000, body, 'new')},v1=${sign(1000)}`, secret, 1000),
			true,
		);
	});

	it('rejects a changed body, a stale timestamp, a wrong secret and a missing header', () => {
		assert.equal(verifySignature(`${body} `, `t=1000,v1=${sign(1000)}`, secret, 1000), false);
		assert.equal(verifySignature(body, `t=1000,v1=${sign(1000)}`, secret, 1061), false);
		assert.equal(verifySignature(body, `t=1000,v1=${sign(1000)}`, 'other', 1000), false);
		assert.equal(verifySignature(body, undefined, secret, 1000), false);
		assert.equal(verifySignature(body, 't=1000', secret, 1000), false);
	});
});

describe('placeholderFields', () => {
	it('turns blueprint placeholders into mapper fields', () => {
		const fields = placeholderFields([
			{ key: 'party_a', label: 'First party', type: 'text', required: true, options: null },
			{ key: 'law', label: null, type: 'choice', required: false, options: ['English', 'Irish'] },
			{ key: 'mutual', label: 'Mutual', type: 'boolean', required: false, options: null },
			{ key: 'schedule', label: 'Schedule', type: 'table', required: false, options: null },
		]);
		assert.deepEqual(
			fields.map((f) => [f.id, f.displayName, f.type, f.required]),
			[
				['party_a', 'First party', 'string', true],
				['law', 'law', 'options', false],
				['mutual', 'Mutual', 'boolean', false],
				['schedule', 'Schedule', 'array', false],
			],
		);
		assert.deepEqual(fields[1].options, [
			{ name: 'English', value: 'English' },
			{ name: 'Irish', value: 'Irish' },
		]);
	});
});
