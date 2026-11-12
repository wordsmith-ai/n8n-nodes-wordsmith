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
const { TRIGGERS } = require('../dist/nodes/WordsmithTrigger/WordsmithTrigger.node.js');

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
const CORE_TRIGGERS = ['task_created', 'task_assigned', 'task_status_changed', 'review_completed'];

describe('Wordsmith node', () => {
	const description = new Wordsmith().description;
	const operations = description.properties
		.filter((property) => property.name === 'operation')
		.flatMap((property) => property.options.map((option) => option.value));

	it('offers every core catalogue action, under its catalogue key', () => {
		assert.deepEqual([...operations].sort(), [...CORE_ACTIONS].sort());
		assert.deepEqual(Object.keys(OPERATIONS).sort(), [...CORE_ACTIONS].sort());
	});

	it('can be used as an AI agent tool', () => {
		assert.equal(description.usableAsTool, true);
	});
});

describe('Wordsmith Trigger', () => {
	it('covers every core trigger', () => {
		for (const key of CORE_TRIGGERS) assert.ok(TRIGGERS[key], key);
		assert.deepEqual(TRIGGERS.task_assigned.eventTypes, ['task.created', 'task.assigned']);
	});

	it('reads the task or review an event names', () => {
		assert.deepEqual(TRIGGERS.task_assigned.enrich({ task_id: 't 1' }), {
			key: 'task',
			id: 't 1',
			path: '/tasks/t%201',
		});
		assert.deepEqual(TRIGGERS.review_completed.enrich({ review_id: 'r1' }), {
			key: 'review',
			id: 'r1',
			path: '/reviews/r1',
		});
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
