import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { Wordsmith } = require('../dist/nodes/Wordsmith/Wordsmith.node.js');
const { OPERATIONS } = require('../dist/nodes/Wordsmith/actions.js');
const {
	pollFor,
	newItems,
} = require('../dist/nodes/WordsmithPollingTrigger/WordsmithPollingTrigger.node.js');
const {
	TRIGGERS,
	WordsmithTrigger,
} = require('../dist/nodes/WordsmithTrigger/WordsmithTrigger.node.js');

// The core tier of the shared automation-connectors catalogue (version 2). Operation values are its keys.
const CORE_ACTIONS = [
	'ask_agent',
	'get_question',
	'upload_file',
	'get_file',
	'redline_document',
	'compare_documents',
	'convert_document',
	'run_review',
	'get_review',
	'draft_document',
	'create_task',
	'update_task',
	'add_task_comment',
	'attach_files_to_task',
	'find_task',
	'get_operation',
];
// The extended actions and searches of the catalogue, all of which this node ships.
const EXTENDED_ACTIONS = [
	'import_file_from_url',
	'create_document',
	'get_file_text',
	'translate_document',
	'redact_document',
	'accept_all_changes',
	'merge_pdfs',
	'generate_review_redline',
	'reply_to_task_requester',
	'get_task_files',
	'create_report',
	'add_report_rows',
	'run_report',
	'export_report',
	'add_documents_to_repository',
	'search_documents',
	'search_legal_sources',
	'find_agent',
	'find_user',
	'find_conversation',
	'find_report',
	'find_repository',
	'get_report_answers',
	'get_conversation_messages',
	'get_legal_source_document',
	'cancel_operation',
];
const CORE_TRIGGERS = ['task_created', 'task_assigned', 'task_status_changed', 'review_completed'];
// The extended triggers this node ships, under their catalogue keys.
const EXTENDED_TRIGGERS = [
	'task_comment_added',
	'agent_waiting_for_input',
	'agent_input_resolved',
	'repository_documents_added',
	'repository_indexing_completed',
	'report_run_completed',
	'job_finished',
	'any_event',
];

describe('Wordsmith node', () => {
	const description = new Wordsmith().description;
	const operations = description.properties
		.filter((property) => property.name === 'operation')
		.flatMap((property) => property.options.map((option) => option.value));

	it('offers every core and extended catalogue action, under its catalogue key', () => {
		const expected = [...CORE_ACTIONS, ...EXTENDED_ACTIONS].sort();
		assert.deepEqual([...operations].sort(), expected);
		assert.deepEqual(Object.keys(OPERATIONS).sort(), expected);
	});

	it('can be used as an AI agent tool', () => {
		assert.equal(description.usableAsTool, true);
	});
});

describe('Wordsmith Trigger', () => {
	it('offers every core trigger and the extended ones, under their catalogue keys', () => {
		const expected = [...CORE_TRIGGERS, ...EXTENDED_TRIGGERS].sort();
		assert.deepEqual(Object.keys(TRIGGERS).sort(), expected);
		const options = new WordsmithTrigger().description.properties.find((p) => p.name === 'event');
		assert.deepEqual(options.options.map((o) => o.value).sort(), expected);
		assert.deepEqual(TRIGGERS.task_assigned.eventTypes, ['task.created', 'task.assigned']);
	});

	it('reads the resources an event names', () => {
		assert.deepEqual(TRIGGERS.task_assigned.reads({ task_id: 't 1' }), [
			{ key: 'task', id: 't 1', path: '/tasks/t%201' },
		]);
		assert.deepEqual(TRIGGERS.review_completed.reads({ review_id: 'r1' }), [
			{ key: 'review', id: 'r1', path: '/reviews/r1' },
		]);
		assert.deepEqual(TRIGGERS.task_comment_added.reads({ task_id: 't1', comment_id: 'c1' }), [
			{ key: 'task', id: 't1', path: '/tasks/t1' },
			{ key: 'comment', id: 'c1', path: '/tasks/t1/comments', find: 'c1' },
		]);
		assert.equal(TRIGGERS.agent_waiting_for_input.reads, undefined);
	});
});

describe('Wordsmith Polling Trigger', () => {
	it('reads the catalogue polling routes', () => {
		assert.deepEqual(pollFor('task_created', 'completed').qs, {
			status: 'not_started,in_progress,waiting_on_external',
			involving: 'me',
		});
		assert.deepEqual(pollFor('task_status_changed', 'completed').qs, { status: 'completed' });
		assert.equal(pollFor('review_completed', 'completed').path, '/reviews');
	});

	it('records existing items on the first poll and returns only new ones after', () => {
		const staticData = {};
		const key = (item) => item.id;
		assert.deepEqual(newItems([{ id: 'a' }, { id: 'b' }], key, staticData), []);
		assert.deepEqual(newItems([{ id: 'c' }, { id: 'a' }], key, staticData), [{ id: 'c' }]);
		assert.deepEqual(newItems([{ id: 'c' }], key, staticData), []);
	});

	it('keeps keys still listed when it reaches its cap, so old items never fire again', () => {
		const staticData = { seenKeys: Array.from({ length: 2000 }, (_, i) => `old-${i}`) };
		const key = (item) => item.id;
		const listed = [{ id: 'old-0' }, { id: 'old-1' }];
		assert.deepEqual(newItems(listed, key, staticData), []);
		for (let i = 0; i < 10; i++) newItems([...listed, { id: `new-${i}` }], key, staticData);
		assert.deepEqual(newItems(listed, key, staticData), []);
	});

	it('fires once when a task reaches the status, and not on later edits', () => {
		const { key } = pollFor('task_status_changed', 'completed');
		const staticData = {};
		newItems([{ id: 't1', status: 'in_progress', updated_at: '1' }], key, staticData);
		const completed = [{ id: 't1', status: 'completed', updated_at: '2' }];
		assert.equal(newItems(completed, key, staticData).length, 1);
		const edited = [{ id: 't1', status: 'completed', updated_at: '3' }];
		assert.equal(newItems(edited, key, staticData).length, 0);
	});
});

describe('a node saved with 0.1.0', () => {
	const run = (typeVersion, parameters) => {
		const read = [];
		const result = new Wordsmith().execute.call({
			getInputData: () => [{ json: {} }],
			getNode: () => ({
				name: 'Wordsmith',
				type: 'n8n-nodes-wordsmith.wordsmith',
				typeVersion,
				parameters,
			}),
			getNodeParameter: (name) => {
				read.push(name);
				return parameters[name];
			},
			continueOnFail: () => true,
		});
		return { result, read };
	};

	it('stops a version-1 node before reading a parameter, even with Continue On Fail', async () => {
		// 0.1.0's Ask was its default resource and operation, so a saved node often holds only its question.
		const { result, read } = run(1, { question: 'Is clause 4 standard?' });
		await assert.rejects(result);
		assert.deepEqual(read, []);
	});

	it('lets a version-2 node run', async () => {
		const { result, read } = run(2, { resource: 'agent', operation: 'no_such_operation' });
		const [items] = await result;
		assert.equal(items.length, 1);
		assert.ok(read.includes('operation'));
	});
});
