import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { OPERATIONS } = require('../dist/nodes/Wordsmith/actions.js');
const { uploadBinary } = require('../dist/nodes/shared/files.js');

const API = 'https://api.wordsmith.ai/api/v1';
const ok = (body, statusCode = 200) => ({ statusCode, headers: {}, body });

/** A minimal IExecuteFunctions: parameters by name, recorded API and storage calls. */
function context({
	parameters = {},
	executionId = 'exec-1',
	binary = 'contract bytes',
	run = 0,
	respond,
}) {
	const calls = [];
	return {
		calls,
		getWorkflowDataProxy: () => ({ $runIndex: run }),
		getNodeParameter: (name, _item, fallback, options) => {
			const value = name in parameters ? parameters[name] : fallback;
			return options?.extractValue && value && typeof value === 'object' ? value.value : value;
		},
		getExecutionId: () => executionId,
		getNode: () => ({ name: 'Wordsmith', type: 'wordsmith', typeVersion: 1 }),
		getCredentials: async () => ({ region: 'eu', apiKey: 'k' }),
		helpers: {
			assertBinaryData: () => ({ fileName: 'nda.docx', mimeType: 'application/msword' }),
			getBinaryDataBuffer: async () => Buffer.from(binary),
			httpRequest: async (options) => {
				calls.push({ method: options.method, url: options.url });
			},
			httpRequestWithAuthentication: async (_name, options) => {
				calls.push({
					method: options.method,
					url: options.url,
					body: options.body,
					headers: options.headers,
				});
				return respond(options);
			},
		},
	};
}

const uploadResponses = (options) => {
	if (options.url.endsWith('/files/upload-url')) {
		return ok({ job_id: 'job1', upload_url: 'https://s3.example.com/put' });
	}
	if (options.url.endsWith('/complete')) return ok({ id: 'file-1', file_name: 'nda.docx' });
	return ok({});
};

describe('uploadBinary', () => {
	it('reuses the file it uploaded when n8n retries the same step', async () => {
		const first = context({ executionId: 'exec-retry', respond: uploadResponses });
		const again = context({ executionId: 'exec-retry', respond: uploadResponses });
		assert.equal((await uploadBinary.call(first, 0, 'data')).id, 'file-1');
		assert.equal((await uploadBinary.call(again, 0, 'data')).id, 'file-1');
		assert.equal(again.calls.length, 0);
		assert.equal(first.calls.filter((c) => c.method === 'PUT').length, 1);
	});

	it('uploads again on the next pass through a loop', async () => {
		const first = context({ executionId: 'exec-loop', respond: uploadResponses });
		await uploadBinary.call(first, 0, 'data');
		const nextRun = context({ executionId: 'exec-loop', run: 1, respond: uploadResponses });
		await uploadBinary.call(nextRun, 0, 'data');
		assert.ok(nextRun.calls.length > 0);
	});

	it('uploads again in another execution or for other content', async () => {
		const other = context({ executionId: 'exec-other', respond: uploadResponses });
		await uploadBinary.call(other, 0, 'data');
		const changed = context({
			executionId: 'exec-retry',
			binary: 'new bytes',
			respond: uploadResponses,
		});
		await uploadBinary.call(changed, 0, 'data');
		assert.ok(other.calls.length > 0 && changed.calls.length > 0);
	});

	it('sends no Authorization header to storage', async () => {
		const ctx = context({ executionId: 'exec-put', respond: uploadResponses });
		await uploadBinary.call(ctx, 0, 'data');
		const put = ctx.calls.find((c) => c.method === 'PUT');
		assert.equal(put.url, 'https://s3.example.com/put');
	});
});

describe('Create a task', () => {
	const withFiles = {
		title: 'Review NDA',
		additionalFields: { fileIds: 'f1', assignedAgent: { mode: 'id', value: 'agent-1' } },
		'additionalFields.assignedAgent': { mode: 'id', value: 'agent-1' },
	};

	it('creates a draft with its agent, attaches the files, then commits it', async () => {
		const ctx = context({
			parameters: withFiles,
			respond: () => ok({ id: 't1', display_id: '#5' }),
		});
		await OPERATIONS.create_task.call(ctx, 0, 'create_task');
		assert.deepEqual(
			ctx.calls.map((c) => [c.method, c.url.replace(API, ''), c.body]),
			[
				['POST', '/tasks', { title: 'Review NDA', assigned_agent: 'agent-1', draft: true }],
				['POST', '/tasks/t1/files', { file_ids: ['f1'] }],
				['PATCH', '/tasks/t1', { draft: false }],
			],
		);
	});

	it('reuses its draft task when n8n retries the step', async () => {
		const failing = context({
			executionId: 'exec-task-retry',
			parameters: withFiles,
			respond: scripted({
				'POST /tasks': [ok({ id: 't9', display_id: '#9' })],
				'POST /tasks/t9/files': [ok({ id: 't9' })],
				'PATCH /tasks/t9': [ok({ error_code: 'service_unavailable', message: 'Busy' }, 400)],
			}),
		});
		await assert.rejects(OPERATIONS.create_task.call(failing, 0, 'create_task'), (error) => {
			assert.equal(error.context.task_id, 't9');
			return true;
		});
		const retry = context({
			executionId: 'exec-task-retry',
			parameters: withFiles,
			respond: () => ok({ id: 't9', draft: false }),
		});
		await OPERATIONS.create_task.call(retry, 0, 'create_task');
		assert.deepEqual(
			retry.calls.map((c) => [c.method, c.url.replace(API, '')]),
			[['PATCH', '/tasks/t9']],
		);
	});

	it('creates the task in one call when there are no files', async () => {
		const ctx = context({
			parameters: {
				title: 'Review NDA',
				additionalFields: { assignedAgent: { mode: 'id', value: 'agent-1' } },
				'additionalFields.assignedAgent': { mode: 'id', value: 'agent-1' },
			},
			respond: () => ok({ id: 't1' }),
		});
		await OPERATIONS.create_task.call(ctx, 0, 'create_task');
		assert.deepEqual(ctx.calls[0].body, { title: 'Review NDA', assigned_agent: 'agent-1' });
		assert.equal(ctx.calls.length, 1);
	});
});

describe('Find a task with Return All', () => {
	it('reads every page', async () => {
		const pages = [
			{ items: [{ id: 'a' }, { id: 'b' }], cursor: 'c1' },
			{ items: [{ id: 'c' }], cursor: null },
		];
		const ctx = context({
			parameters: { taskId: '', filters: {}, returnAll: true },
			respond: () => ok(pages.shift()),
		});
		const result = await OPERATIONS.find_task.call(ctx, 0, 'find_task');
		assert.deepEqual(
			result.map((r) => r.json.id),
			['a', 'b', 'c'],
		);
	});
});

describe('Draft a document without waiting', () => {
	it('sends the blueprint with its instructions and background, and returns the job', async () => {
		const ctx = context({
			parameters: {
				blueprint: { mode: 'id', value: 'bp1' },
				instructions: 'A short NDA',
				draftOptions: { context: 'Facts' },
				waitForResult: false,
			},
			respond: () => ok({ id: 'op1', status: 'queued' }),
		});
		const [result] = await OPERATIONS.draft_document.call(ctx, 0, 'draft_document');
		assert.deepEqual(ctx.calls[0].body, {
			output_format: 'docx',
			blueprint_id: 'bp1',
			instructions: 'A short NDA',
			context: 'Facts',
		});
		assert.equal(result.json.id, 'op1');
		assert.equal(ctx.calls[0].headers['Idempotency-Key'], 'n8n:exec-1:Wordsmith:0:0');
	});
});

/** Answers each request with the next scripted response for its method and path. */
function scripted(routes) {
	return (options) => {
		const path = options.url.replace(API, '').split('?')[0];
		const key = `${options.method} ${path}`;
		const queue = routes[key];
		if (!queue || queue.length === 0) throw new Error(`unexpected request ${key}`);
		return queue.length > 1 ? queue.shift() : queue[0];
	};
}

function downloadable(ctx) {
	ctx.helpers.httpRequest = async (options) => {
		ctx.calls.push({ method: options.method, url: options.url });
		return new TextEncoder().encode('redlined bytes').buffer;
	};
	ctx.helpers.prepareBinaryData = async (buffer, fileName, mimeType) => ({
		data: Buffer.from(buffer).toString('base64'),
		fileName,
		mimeType,
	});
	return ctx;
}

describe('Redline a document', () => {
	it('starts the job, waits on it, and downloads the redline into binary data', async () => {
		const ctx = downloadable(
			context({
				parameters: {
					documentSource: 'id',
					documentId: 'f1',
					instructions: 'Cap liability',
					redlineOptions: {},
					waitForResult: true,
					maxWaitMinutes: 15,
					outputBinaryField: 'data',
				},
				respond: scripted({
					'POST /files/f1/redline': [ok({ id: 'op1', status: 'queued' }, 202)],
					'GET /operations/op1': [
						ok({
							id: 'op1',
							status: 'succeeded',
							result: { file_ids: ['f2'], summary: { insertions: 1 } },
						}),
					],
					'GET /files/f2/download': [
						ok({
							file_id: 'f2',
							url: 'https://s3.example.com/f2',
							web_url: 'https://app.wordsmith.ai/files/f2/download',
							file_name: 'nda.docx',
							content_type: 'application/msword',
						}),
					],
				}),
			}),
		);
		const [result] = await OPERATIONS.redline_document.call(ctx, 0, 'redline_document');
		assert.equal(ctx.calls[0].headers['Idempotency-Key'], 'n8n:exec-1:Wordsmith:0:0');
		assert.deepEqual(ctx.calls[0].body, { instructions: 'Cap liability' });
		assert.equal(result.json.file_id, 'f2');
		assert.equal(result.json.web_url, 'https://app.wordsmith.ai/files/f2/download');
		assert.equal(result.json.operation_id, 'op1');
		assert.equal('url' in result.json, false);
		assert.equal(result.binary.data.fileName, 'nda.docx');
	});

	it('fails the step with the job id when the job fails', async () => {
		const ctx = context({
			parameters: {
				documentSource: 'id',
				documentId: 'f1',
				instructions: 'Cap liability',
				waitForResult: true,
				maxWaitMinutes: 15,
			},
			respond: scripted({
				'POST /files/f1/redline': [ok({ id: 'op1', status: 'queued' }, 202)],
				'GET /operations/op1': [
					ok({
						id: 'op1',
						status: 'failed',
						error: { code: 'unsupported_file', message: 'Not a Word file' },
					}),
				],
			}),
		});
		await assert.rejects(OPERATIONS.redline_document.call(ctx, 0, 'redline_document'), (error) => {
			assert.equal(error.name, 'NodeOperationError');
			assert.equal(error.context.operation_id, 'op1');
			assert.equal(error.context.error_code, 'unsupported_file');
			return true;
		});
	});
});

describe('Ask an agent', () => {
	const askParameters = {
		agent: { mode: 'list', value: 'default' },
		question: 'Is this clause standard?',
		options: {},
		waitForResult: true,
		maxWaitMinutes: 15,
	};

	it('waits on the question’s operation, then reads the answer', async () => {
		const ctx = context({
			parameters: askParameters,
			respond: scripted({
				'POST /agents/default/questions': [
					ok({ id: 'q1', status: 'in_progress', operation_id: 'op1' }),
				],
				'GET /operations/op1': [ok({ id: 'op1', status: 'succeeded' })],
				'GET /agents/default/questions/q1': [
					ok({ id: 'q1', status: 'completed', answer: 'Yes.', answer_html: '<p>Yes.</p>' }),
				],
			}),
		});
		const [result] = await OPERATIONS.ask_agent.call(ctx, 0, 'ask_agent');
		assert.equal(result.json.answer_html, '<p>Yes.</p>');
	});

	it('fails when the start call already reports an error', async () => {
		const ctx = context({
			parameters: askParameters,
			respond: scripted({
				'POST /agents/default/questions': [ok({ id: 'q1', status: 'error', answer: 'partial' })],
			}),
		});
		await assert.rejects(OPERATIONS.ask_agent.call(ctx, 0, 'ask_agent'), (error) => {
			assert.equal(error.context.question_id, 'q1');
			return true;
		});
	});

	it('returns a declined question as a success', async () => {
		const ctx = context({
			parameters: askParameters,
			respond: scripted({
				'POST /agents/default/questions': [
					ok({ id: 'q1', status: 'filtered', reason: 'Not this agent’s work' }),
				],
			}),
		});
		const [result] = await OPERATIONS.ask_agent.call(ctx, 0, 'ask_agent');
		assert.equal(result.json.status, 'filtered');
	});
});

describe('Create a task when attaching files fails', () => {
	it('names the draft task it created', async () => {
		const ctx = context({
			executionId: 'exec-attach-fails',
			parameters: { title: 'Review NDA', additionalFields: { fileIds: 'f1' } },
			respond: scripted({
				'POST /tasks': [ok({ id: 't1', display_id: '#5', url: 'https://app/tasks?activeId=t1' })],
				'POST /tasks/t1/files': [ok({ error_code: 'not_found', message: 'File not found' }, 404)],
			}),
		});
		await assert.rejects(OPERATIONS.create_task.call(ctx, 0, 'create_task'), (error) => {
			assert.equal(error.context.task_id, 't1');
			assert.equal(error.context.draft, true);
			return true;
		});
	});
});

describe('wordsmithRequest', () => {
	it('retries a 429 after Retry-After and returns the next answer', async () => {
		const { wordsmithApi } = require('../dist/nodes/shared/transport.js');
		const ctx = context({
			respond: scripted({
				'GET /me': [
					{
						statusCode: 429,
						headers: { 'retry-after': '1' },
						body: { error_code: 'rate_limited' },
					},
					ok({ user_id: 'u1' }),
				],
			}),
		});
		assert.deepEqual(await wordsmithApi.call(ctx, 'GET', '/me'), { user_id: 'u1' });
		assert.equal(ctx.calls.length, 2);
	});

	it('does not retry another 4xx', async () => {
		const { wordsmithApi } = require('../dist/nodes/shared/transport.js');
		const ctx = context({
			respond: scripted({ 'GET /me': [ok({ error_code: 'forbidden', message: 'No' }, 403)] }),
		});
		await assert.rejects(wordsmithApi.call(ctx, 'GET', '/me'), {
			name: 'NodeApiError',
			httpCode: '403',
		});
		assert.equal(ctx.calls.length, 1);
	});
});
