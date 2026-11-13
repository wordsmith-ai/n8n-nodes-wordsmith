import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { OPERATIONS, answerKeys } = require('../dist/nodes/Wordsmith/actions.js');
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
					qs: options.qs,
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

describe('Document actions added from the catalogue', () => {
	const started = { id: 'op1', status: 'queued' };
	const noWait = { waitForResult: false };

	it('redacts the chosen categories and terms, and refuses an empty request', async () => {
		const ctx = context({
			parameters: {
				...noWait,
				documentSource: 'id',
				documentId: 'f1',
				categories: ['names', 'emails'],
				terms: 'Project Falcon, Acme Ltd',
			},
			respond: scripted({ 'POST /files/f1/redact': [ok(started, 202)] }),
		});
		await OPERATIONS.redact_document.call(ctx, 0, 'redact_document');
		assert.deepEqual(ctx.calls[0].body, {
			categories: ['names', 'emails'],
			terms: ['Project Falcon', 'Acme Ltd'],
		});

		const empty = context({
			parameters: { ...noWait, documentSource: 'id', documentId: 'f1', categories: [], terms: '' },
			respond: () => ok(started, 202),
		});
		await assert.rejects(OPERATIONS.redact_document.call(empty, 0, 'redact_document'), {
			name: 'NodeOperationError',
		});
		assert.equal(empty.calls.length, 0);
	});

	it('merges the documents in order, and needs at least two', async () => {
		const ctx = context({
			parameters: { ...noWait, documents: { fileIds: 'f2, f1' }, fileName: 'Bundle.pdf' },
			respond: scripted({ 'POST /files/merge': [ok(started, 202)] }),
		});
		await OPERATIONS.merge_pdfs.call(ctx, 0, 'merge_pdfs');
		assert.deepEqual(ctx.calls[0].body, { file_ids: ['f2', 'f1'], file_name: 'Bundle.pdf' });

		const one = context({
			parameters: { ...noWait, documents: { fileIds: 'f1' } },
			respond: () => ok(started, 202),
		});
		await assert.rejects(OPERATIONS.merge_pdfs.call(one, 0, 'merge_pdfs'), {
			name: 'NodeOperationError',
		});
		assert.equal(one.calls.length, 0);
	});

	it('translates into the language code given', async () => {
		const ctx = context({
			parameters: { ...noWait, documentSource: 'id', documentId: 'f1', targetLanguage: ' de ' },
			respond: scripted({ 'POST /files/f1/translate': [ok(started, 202)] }),
		});
		const [result] = await OPERATIONS.translate_document.call(ctx, 0, 'translate_document');
		assert.deepEqual(ctx.calls[0].body, { target_language: 'de' });
		assert.equal(result.json.id, 'op1');
	});
});

describe('Get a task’s files', () => {
	it('downloads each file through the task’s own download route', async () => {
		const ctx = downloadable(
			context({
				parameters: { taskId: '#12', downloadFiles: true },
				respond: scripted({
					'GET /tasks/12/files': [
						ok({ task_id: 't1', input_files: [{ id: 'f1' }], output_files: [{ id: 'f2' }] }),
					],
					'GET /tasks/t1/files/f1/download': [ok({ file_id: 'f1', url: 'https://s3/f1' })],
					'GET /tasks/t1/files/f2/download': [ok({ file_id: 'f2', url: 'https://s3/f2' })],
				}),
			}),
		);
		const [result] = await OPERATIONS.get_task_files.call(ctx, 0, 'get_task_files');
		assert.deepEqual(Object.keys(result.binary).sort(), ['input_0', 'output_0']);
		assert.deepEqual(result.json.output_files, [{ id: 'f2' }]);
	});
});

describe('Reports', () => {
	it('creates a report with its columns and an idempotency key', async () => {
		const ctx = context({
			parameters: {
				name: 'Supplier NDAs',
				run: true,
				documents: { fileIds: 'f1' },
				columns: {
					column: [
						{ name: 'Law', prompt: 'Which law?', type: 'single_select', options: 'England, NY' },
						{ name: 'Term', prompt: 'How long?', type: 'text', options: '' },
					],
				},
			},
			respond: () => ok({ id: 'r1', operation_id: 'op1' }, 201),
		});
		await OPERATIONS.create_report.call(ctx, 0, 'create_report');
		assert.deepEqual(ctx.calls[0].body, {
			name: 'Supplier NDAs',
			run: true,
			file_ids: ['f1'],
			columns: [
				{ name: 'Law', prompt: 'Which law?', type: 'single_select', options: ['England', 'NY'] },
				{ name: 'Term', prompt: 'How long?', type: 'text' },
			],
		});
		assert.ok(ctx.calls[0].headers['Idempotency-Key']);
	});

	it('fails Add Documents only when no document was added', async () => {
		const report = { mode: 'id', value: 'r1' };
		const partial = context({
			parameters: { report, documents: { fileIds: 'f1, f2' } },
			respond: () => ok({ items: [{ id: 'row1' }], failed_file_ids: ['f2'] }),
		});
		const [result] = await OPERATIONS.add_report_rows.call(partial, 0, 'add_report_rows');
		assert.deepEqual(result.json.failed_file_ids, ['f2']);

		const none = context({
			parameters: { report, documents: { fileIds: 'f1' } },
			respond: () => ok({ items: [], failed_file_ids: ['f1'] }),
		});
		await assert.rejects(OPERATIONS.add_report_rows.call(none, 0, 'add_report_rows'), (error) => {
			assert.equal(error.name, 'NodeOperationError');
			assert.deepEqual(error.context.failed_file_ids, ['f1']);
			return true;
		});
	});

	it('exports a report, waits, and downloads the file', async () => {
		const ctx = downloadable(
			context({
				parameters: {
					report: { mode: 'id', value: 'r1' },
					format: 'csv',
					waitForResult: true,
					maxWaitMinutes: 15,
					outputBinaryField: 'data',
				},
				respond: scripted({
					'POST /reports/r1/exports': [ok({ id: 'op1', status: 'queued' }, 202)],
					'GET /operations/op1': [
						ok({ id: 'op1', status: 'succeeded', result: { file_id: 'f9' } }),
					],
					'GET /files/f9/download': [
						ok({ file_id: 'f9', url: 'https://s3/f9', file_name: 'report.csv' }),
					],
				}),
			}),
		);
		const [result] = await OPERATIONS.export_report.call(ctx, 0, 'export_report');
		assert.deepEqual(ctx.calls[0].body, { format: 'csv' });
		assert.equal(result.json.file_id, 'f9');
		assert.equal(result.binary.data.fileName, 'report.csv');
	});
});

describe('Searches', () => {
	it('finds a user by exact email before matching names', async () => {
		const users = [
			{ email: 'sam@example.com', name: 'Sam Lee' },
			{ email: 'samantha@example.com', name: 'Samantha Cole' },
		];
		const exact = context({ parameters: { query: 'SAM@example.com' }, respond: () => ok(users) });
		assert.deepEqual(
			(await OPERATIONS.find_user.call(exact, 0, 'find_user')).map((r) => r.json.email),
			['sam@example.com'],
		);
		const byName = context({ parameters: { query: 'sam' }, respond: () => ok(users) });
		assert.equal((await OPERATIONS.find_user.call(byName, 0, 'find_user')).length, 2);
	});

	it('returns document search results with a text summary', async () => {
		const ctx = context({
			parameters: { query: 'liability cap', repositoryIds: 'rp1', limit: 5 },
			respond: () =>
				ok({
					items: [{ file_name: 'MSA.docx', snippet: 'Liability is capped' }],
					searched_repository_ids: ['rp1'],
				}),
		});
		const [result] = await OPERATIONS.search_documents.call(ctx, 0, 'search_documents');
		assert.deepEqual(ctx.calls[0].body, {
			query: 'liability cap',
			limit: 5,
			repository_ids: ['rp1'],
		});
		assert.equal(result.json.results_text, 'MSA.docx: Liability is capped');
	});

	it('sends legal research dates as days and jurisdictions in lower case', async () => {
		const ctx = context({
			parameters: {
				query: 'unfair terms',
				limit: 10,
				researchOptions: { jurisdictions: 'GB, eu', dateFrom: '2024-01-01T00:00:00.000Z' },
			},
			respond: () => ok({ items: [], sources: [] }),
		});
		await OPERATIONS.search_legal_sources.call(ctx, 0, 'search_legal_sources');
		assert.deepEqual(ctx.calls[0].body, {
			query: 'unfair terms',
			limit: 10,
			jurisdictions: ['gb', 'eu'],
			date_from: '2024-01-01',
		});
	});

	it('reads a file’s text from the offset given', async () => {
		const ctx = context({
			parameters: { fileId: 'f1', maxChars: 500, offset: 1000 },
			respond: () => ok({ text: '…', next_offset: 1500 }),
		});
		await OPERATIONS.get_file_text.call(ctx, 0, 'get_file_text');
		assert.equal(ctx.calls[0].url, `${API}/files/f1/text`);
		assert.deepEqual(ctx.calls[0].qs, { max_chars: 500, offset: 1000 });
	});
});

describe('Get the answers in a report', () => {
	it('outputs one item per row with answers keyed by column name', async () => {
		const ctx = context({
			parameters: { report: { mode: 'id', value: 'r1' } },
			respond: scripted({
				'GET /reports/r1': [ok({ id: 'r1', columns: [{ id: 'c1', name: 'Governing law' }] })],
				'GET /reports/r1/rows': [
					ok({ items: [{ id: 'row1', file_id: 'f1', name: 'NDA.docx' }], cursor: null }),
				],
				'GET /reports/r1/cells': [
					ok({
						items: [{ row_id: 'row1', column_id: 'c1', value: 'England', status: 'done' }],
						cursor: null,
					}),
				],
			}),
		});
		const results = await OPERATIONS.get_report_answers.call(ctx, 0, 'get_report_answers');
		assert.deepEqual(results[0].json, {
			report_id: 'r1',
			row_id: 'row1',
			file_id: 'f1',
			file_name: 'NDA.docx',
			answers: { 'Governing law': 'England' },
			statuses: { 'Governing law': 'done' },
		});
	});
});

describe('Document order', () => {
	it('merges uploaded binary fields first, then file IDs', async () => {
		const ctx = context({
			executionId: 'exec-merge-order',
			parameters: {
				waitForResult: false,
				documents: { binaryFields: 'data', fileIds: 'f2' },
			},
			respond: (options) =>
				options.url.endsWith('/files/merge')
					? ok({ id: 'op1', status: 'queued' }, 202)
					: uploadResponses(options),
		});
		await OPERATIONS.merge_pdfs.call(ctx, 0, 'merge_pdfs');
		const merge = ctx.calls.find((c) => c.url.endsWith('/files/merge'));
		assert.deepEqual(merge.body.file_ids, ['file-1', 'f2']);
	});
});

describe('Report answer keys', () => {
	it('keeps every column when two share a name', () => {
		const keys = answerKeys([
			{ id: 'c1', name: 'Term' },
			{ id: 'c2', name: 'Term' },
			{ id: 'c3', name: 'Law' },
		]);
		assert.equal(new Set(keys.values()).size, 3);
		assert.equal(keys.get('c3'), 'Law');
	});
});

describe('Results that are partial or empty', () => {
	it('says when a document search covered fewer repositories than asked', async () => {
		const ctx = context({
			parameters: { query: 'indemnity', repositoryIds: 'rp1, rp2', limit: 5 },
			respond: () => ok({ items: [], searched_repository_ids: ['rp1'] }),
		});
		const [result] = await OPERATIONS.search_documents.call(ctx, 0, 'search_documents');
		assert.match(result.json.results_text, /rp2/);
	});

	it('fails Add Documents to a Repository when nothing was indexed', async () => {
		const run = (result) =>
			context({
				parameters: {
					repository: { mode: 'id', value: 'rp1' },
					documents: { fileIds: 'f1, f2' },
					waitForResult: true,
					maxWaitMinutes: 15,
				},
				respond: scripted({
					'POST /repositories/rp1/documents': [ok({ id: 'op1', status: 'queued' }, 202)],
					'GET /operations/op1': [ok({ id: 'op1', status: 'succeeded', result })],
				}),
			});
		const [partial] = await OPERATIONS.add_documents_to_repository.call(
			run({ indexed: 1, failed: 1 }),
			0,
			'add_documents_to_repository',
		);
		assert.deepEqual(partial.json, {
			repository_id: 'rp1',
			indexed: 1,
			failed: 1,
			operation_id: 'op1',
		});
		await assert.rejects(
			OPERATIONS.add_documents_to_repository.call(
				run({ indexed: 0, failed: 2 }),
				0,
				'add_documents_to_repository',
			),
			{ name: 'NodeOperationError' },
		);
	});

	it('creates a report without running it when it has no documents or no columns', async () => {
		const ctx = context({
			parameters: { name: 'Empty', run: true, documents: {}, columns: {} },
			respond: () => ok({ id: 'r1' }, 201),
		});
		await OPERATIONS.create_report.call(ctx, 0, 'create_report');
		assert.equal(ctx.calls[0].body.run, false);
	});

	it('outputs a report run’s counts', async () => {
		const ctx = context({
			parameters: {
				report: { mode: 'id', value: 'r1' },
				onlyEmpty: false,
				waitForResult: true,
				maxWaitMinutes: 15,
			},
			respond: scripted({
				'POST /reports/r1/runs': [ok({ id: 'op1', status: 'queued' }, 202)],
				'GET /operations/op1': [
					ok({ id: 'op1', status: 'succeeded', result: { cells_completed: 4, cells_total: 6 } }),
				],
			}),
		});
		const [result] = await OPERATIONS.run_report.call(ctx, 0, 'run_report');
		assert.deepEqual(ctx.calls[0].body, { only_empty: false });
		assert.deepEqual(result.json, {
			report_id: 'r1',
			cells_completed: 4,
			cells_total: 6,
			operation_id: 'op1',
		});
	});

	it('gives each report row only its own cells', async () => {
		const ctx = context({
			parameters: { report: { mode: 'id', value: 'r1' } },
			respond: scripted({
				'GET /reports/r1': [ok({ id: 'r1', columns: [{ id: 'c1', name: 'Law' }] })],
				'GET /reports/r1/rows': [ok({ items: [{ id: 'a' }, { id: 'b' }], cursor: null })],
				'GET /reports/r1/cells': [
					ok({
						items: [
							{ row_id: 'b', column_id: 'c1', value: 'NY', status: 'done' },
							{ row_id: 'a', column_id: 'c1', value: 'England', status: 'done' },
						],
						cursor: null,
					}),
				],
			}),
		});
		const rows = await OPERATIONS.get_report_answers.call(ctx, 0, 'get_report_answers');
		assert.deepEqual(
			rows.map((row) => [row.json.row_id, row.json.answers.Law]),
			[
				['a', 'England'],
				['b', 'NY'],
			],
		);
	});
});

describe('Task replies and review redlines', () => {
	it('replies to a task by number, sending files only when given', async () => {
		const bare = context({
			parameters: { taskId: '#12', content: 'Done', files: {} },
			respond: () => ok({ id: 'm1' }),
		});
		await OPERATIONS.reply_to_task_requester.call(bare, 0, 'reply_to_task_requester');
		assert.equal(bare.calls[0].url, `${API}/tasks/12/thread`);
		assert.deepEqual(bare.calls[0].body, { content: 'Done' });

		const withFiles = context({
			parameters: { taskId: '#12', content: 'Done', files: { fileIds: 'f1' } },
			respond: () => ok({ id: 'm2' }),
		});
		await OPERATIONS.reply_to_task_requester.call(withFiles, 0, 'reply_to_task_requester');
		assert.deepEqual(withFiles.calls[0].body, { content: 'Done', file_ids: ['f1'] });
	});

	it('sends only the chosen findings to the review redline', async () => {
		const ctx = context({
			parameters: { reviewId: 'rv1', findingIds: 'fd1, fd2', waitForResult: false },
			respond: () => ok({ id: 'op1', status: 'queued' }, 202),
		});
		await OPERATIONS.generate_review_redline.call(ctx, 0, 'generate_review_redline');
		assert.equal(ctx.calls[0].url, `${API}/reviews/rv1/redline`);
		assert.deepEqual(ctx.calls[0].body, { finding_ids: ['fd1', 'fd2'] });
	});
});

describe('Search and report defaults', () => {
	it('puts the search scope before the results when no repositories are named', async () => {
		const ctx = context({
			parameters: { query: 'indemnity', repositoryIds: '', limit: 5 },
			respond: () =>
				ok({
					items: [{ file_name: 'MSA.docx', snippet: 'Indemnity cap' }],
					searched_repository_ids: ['rp1', 'rp2'],
				}),
		});
		const [result] = await OPERATIONS.search_documents.call(ctx, 0, 'search_documents');
		assert.equal('repository_ids' in ctx.calls[0].body, false);
		const paragraphs = result.json.results_text.split('\n\n');
		assert.equal(paragraphs.length, 2);
		assert.equal(paragraphs[1], 'MSA.docx: Indemnity cap');
	});

	it('runs a new report only when it has both documents and columns', async () => {
		const create = async (parameters) => {
			const ctx = context({
				parameters: { name: 'Report', run: true, ...parameters },
				respond: () => ok({ id: 'r1' }, 201),
			});
			await OPERATIONS.create_report.call(ctx, 0, 'create_report');
			return ctx.calls[0].body.run;
		};
		const column = { column: [{ name: 'Law', prompt: 'Which law?', type: 'text', options: '' }] };
		assert.equal(await create({ documents: { fileIds: 'f1' }, columns: {} }), false);
		assert.equal(await create({ documents: {}, columns: column }), false);
		assert.equal(await create({ documents: { fileIds: 'f1' }, columns: column }), true);
	});
});
