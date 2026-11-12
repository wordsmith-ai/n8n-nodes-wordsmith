import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';

import { filesOptions, locatorModes, returnAllAndLimit, show } from './common';

export const TASK_STATUSES: INodePropertyOptions[] = [
	{ name: 'Not Started', value: 'not_started' },
	{ name: 'In Progress', value: 'in_progress' },
	{ name: 'Waiting on Someone Else', value: 'waiting_on_external' },
	{ name: 'Completed', value: 'completed' },
	{ name: 'Cancelled', value: 'cancelled' },
];

const PRIORITIES: INodePropertyOptions[] = [
	{ name: 'No Priority', value: 'no_priority' },
	{ name: 'Urgent', value: 'urgent' },
	{ name: 'High', value: 'high' },
	{ name: 'Medium', value: 'medium' },
	{ name: 'Low', value: 'low' },
];

const taskAgentLocator: INodeProperties = {
	displayName: 'Agent',
	name: 'assignedAgent',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	description:
		'The agent to start on the task. Only agents with an API intake are listed; the list is empty until one has.',
	modes: locatorModes('searchTaskAgents'),
};

const assigneeLocator: INodeProperties = {
	displayName: 'Assignee',
	name: 'assignedTo',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	description: 'An email, a name, or me',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchUsers', searchable: true },
		},
		{
			displayName: 'By Email or Name',
			name: 'email',
			type: 'string',
			placeholder: 'e.g. name@example.com, or me',
		},
	],
};

const taskIdProperty = (operations: string[], required = true): INodeProperties => ({
	displayName: required ? 'Task' : 'Task ID or Number',
	name: 'taskId',
	type: 'string',
	required,
	default: '',
	placeholder: 'e.g. #12',
	description: required
		? 'The task’s ID, or its number such as #12'
		: 'The task’s ID or number. Leave empty to search instead.',
	displayOptions: show('task', operations),
});

export const taskProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['task'] } },
		options: [
			{
				name: 'Add Comment',
				value: 'add_task_comment',
				action: 'Add a comment to a task',
				description: 'Post a comment on a task, with optional files',
			},
			{
				name: 'Attach Files',
				value: 'attach_files_to_task',
				action: 'Attach files to a task',
				description: 'Add files to a task’s inputs',
			},
			{
				name: 'Create',
				value: 'create_task',
				action: 'Create a task',
				description:
					'Create a task in Wordsmith. Assign it to an agent to have the agent start on it, or to a person.',
			},
			{
				name: 'Find',
				value: 'find_task',
				action: 'Find a task',
				description: 'Get a task by its ID or number, or the first task that matches your search',
			},
			{
				name: 'Update',
				value: 'update_task',
				action: 'Update a task',
				description:
					'Change a task’s status, assignee, priority, due date, title or description. Empty fields stay as they are.',
			},
		],
		default: 'create_task',
	},
	{
		displayName: 'Title',
		name: 'title',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Review supplier NDA',
		displayOptions: show('task', ['create_task']),
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show('task', ['create_task']),
		options: [
			taskAgentLocator,
			assigneeLocator,
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
			},
			{ displayName: 'Due Date', name: 'completeBy', type: 'dateTime', default: '' },
			...filesOptions('Files to add to the task.'),
			{
				displayName: 'Parent Task',
				name: 'parentTaskId',
				type: 'string',
				default: '',
				placeholder: 'e.g. #12',
			},
			{
				displayName: 'Priority',
				name: 'priority',
				type: 'options',
				options: PRIORITIES,
				default: 'no_priority',
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				placeholder: 'e.g. nda, supplier',
				description: 'Comma-separated labels',
			},
		],
	},
	taskIdProperty(['update_task', 'add_task_comment', 'attach_files_to_task']),
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show('task', ['update_task']),
		options: [
			taskAgentLocator,
			assigneeLocator,
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
			},
			{ displayName: 'Due Date', name: 'completeBy', type: 'dateTime', default: '' },
			{
				displayName: 'Priority',
				name: 'priority',
				type: 'options',
				options: PRIORITIES,
				default: 'no_priority',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: TASK_STATUSES,
				default: 'in_progress',
			},
			{ displayName: 'Title', name: 'title', type: 'string', default: '' },
		],
	},
	{
		displayName: 'Comment',
		name: 'content',
		type: 'string',
		required: true,
		typeOptions: { rows: 4 },
		default: '',
		displayOptions: show('task', ['add_task_comment']),
	},
	{
		displayName: 'Files',
		name: 'files',
		type: 'collection',
		placeholder: 'Add Files',
		default: {},
		displayOptions: show('task', ['add_task_comment', 'attach_files_to_task']),
		options: filesOptions('Files to add.'),
	},
	taskIdProperty(['find_task'], false),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['task'], operation: ['find_task'], taskId: [''] } },
		options: [
			assigneeLocator,
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: TASK_STATUSES,
				default: 'in_progress',
			},
			{ displayName: 'Title Contains', name: 'query', type: 'string', default: '' },
		],
	},
	...returnAllAndLimit('task', ['find_task']).map((property) => ({
		...property,
		displayOptions: { show: { ...property.displayOptions?.show, taskId: [''] } },
	})),
];

export const jobProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['job'] } },
		options: [
			{
				name: 'Get',
				value: 'get_operation',
				action: 'Get a job',
				description: 'Get a background job’s status and result, such as a review or a draft',
			},
		],
		default: 'get_operation',
	},
	{
		displayName: 'Job ID',
		name: 'operationId',
		type: 'string',
		required: true,
		default: '',
		description: 'The operation_id an earlier step returned',
		displayOptions: show('job', ['get_operation']),
	},
];
