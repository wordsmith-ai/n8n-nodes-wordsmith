import type { INodeProperties } from 'n8n-workflow';

import {
	filesOptions,
	locatorModes,
	outputBinaryField,
	returnAllAndLimit,
	show,
	waitProperties,
} from './common';

const reportLocator = (operations: string[]): INodeProperties => ({
	displayName: 'Report',
	name: 'report',
	type: 'resourceLocator',
	required: true,
	default: { mode: 'list', value: '' },
	modes: locatorModes('searchReports'),
	displayOptions: show('report', operations),
});

const repositoryLocator = (
	resource: string,
	operations: string[],
	required = true,
): INodeProperties => ({
	displayName: 'Repository',
	name: 'repository',
	type: 'resourceLocator',
	required,
	default: { mode: 'list', value: '' },
	modes: locatorModes('searchRepositories'),
	displayOptions: show(resource, operations),
});

const nameContains = (resource: string, operation: string, label: string): INodeProperties => ({
	displayName: label,
	name: 'query',
	type: 'string',
	required: true,
	default: '',
	displayOptions: show(resource, [operation]),
});

const documentsCollection = (
	resource: string,
	operations: string[],
	description: string,
): INodeProperties => ({
	displayName: 'Documents',
	name: 'documents',
	type: 'collection',
	placeholder: 'Add Documents',
	default: {},
	description,
	displayOptions: show(resource, operations),
	options: filesOptions('The documents to add.'),
});

const COLUMN_TYPES = [
	{ name: 'Date', value: 'date' },
	{ name: 'Multiple Choice', value: 'multi_select' },
	{ name: 'Number', value: 'number' },
	{ name: 'Single Choice', value: 'single_select' },
	{ name: 'Text', value: 'text' },
	{ name: 'Yes or No', value: 'boolean' },
];

export const reportProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['report'] } },
		options: [
			{
				name: 'Add Documents',
				value: 'add_report_rows',
				action: 'Add documents to a report',
				description: 'Add documents to a report as new rows',
			},
			{
				name: 'Create',
				value: 'create_report',
				action: 'Create a report',
				description: 'Create a report that extracts the same answers from many documents',
			},
			{
				name: 'Export',
				value: 'export_report',
				action: 'Export a report',
				description: 'Export a report as an Excel, CSV or JSON file',
			},
			{
				name: 'Find',
				value: 'find_report',
				action: 'Find a report',
				description: 'Get the reports whose name contains your search',
			},
			{
				name: 'Get Answers',
				value: 'get_report_answers',
				action: 'Get the answers in a report',
				description: 'Get every row of a report with its answers, one item per document',
			},
			{
				name: 'Run',
				value: 'run_report',
				action: 'Run a report',
				description: 'Fill in a report’s answers, by default only the empty ones',
			},
		],
		default: 'create_report',
	},
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Supplier NDAs',
		displayOptions: show('report', ['create_report']),
	},
	documentsCollection('report', ['create_report'], 'Up to 10 documents, one row each'),
	{
		displayName: 'Columns',
		name: 'columns',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Column',
		default: {},
		description: 'The questions to answer for every document, up to 20',
		displayOptions: show('report', ['create_report']),
		options: [
			{
				displayName: 'Column',
				name: 'column',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						placeholder: 'e.g. Governing law',
					},
					{
						displayName: 'Question',
						name: 'prompt',
						type: 'string',
						default: '',
						placeholder: 'e.g. Which law governs this agreement?',
					},
					{
						displayName: 'Answer Type',
						name: 'type',
						type: 'options',
						options: COLUMN_TYPES,
						default: 'text',
					},
					{
						displayName: 'Choices',
						name: 'options',
						type: 'string',
						default: '',
						placeholder: 'e.g. England, New York, Delaware',
						description: 'Comma-separated choices, for a Single Choice or Multiple Choice column',
					},
				],
			},
		],
	},
	{
		displayName: 'Run Now',
		name: 'run',
		type: 'boolean',
		default: true,
		description:
			'Whether to start filling in the answers at once. A report without documents or columns has nothing to run yet.',
		displayOptions: show('report', ['create_report']),
	},
	reportLocator(['add_report_rows', 'run_report', 'export_report', 'get_report_answers']),
	documentsCollection('report', ['add_report_rows'], 'Up to 10 documents, one row each'),
	{
		displayName: 'Only Empty Cells',
		name: 'onlyEmpty',
		type: 'boolean',
		default: true,
		description: 'Whether to fill in only the answers that are still empty',
		displayOptions: show('report', ['run_report']),
	},
	{
		displayName: 'Format',
		name: 'format',
		type: 'options',
		options: [
			{ name: 'Excel', value: 'xlsx' },
			{ name: 'CSV', value: 'csv' },
			{ name: 'JSON', value: 'json' },
		],
		default: 'xlsx',
		displayOptions: show('report', ['export_report']),
	},
	nameContains('report', 'find_report', 'Name Contains'),
	...returnAllAndLimit('report', ['find_report']),
	...waitProperties('report', ['run_report', 'export_report']),
	{
		...outputBinaryField('report', ['export_report']),
		displayOptions: {
			show: { resource: ['report'], operation: ['export_report'], waitForResult: [true] },
		},
	},
];

export const repositoryProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['repository'] } },
		options: [
			{
				name: 'Add Documents',
				value: 'add_documents_to_repository',
				action: 'Add documents to a repository',
				description: 'Add documents to a repository and wait for them to be indexed',
			},
			{
				name: 'Find',
				value: 'find_repository',
				action: 'Find a repository',
				description: 'Get the repositories whose name contains your search',
			},
		],
		default: 'add_documents_to_repository',
	},
	repositoryLocator('repository', ['add_documents_to_repository']),
	documentsCollection('repository', ['add_documents_to_repository'], 'Up to 100 documents'),
	{
		displayName: 'Folder ID',
		name: 'folderId',
		type: 'string',
		default: '',
		description: 'The folder to add them to. Leave empty for the top of the repository.',
		displayOptions: show('repository', ['add_documents_to_repository']),
	},
	nameContains('repository', 'find_repository', 'Name Contains'),
	...returnAllAndLimit('repository', ['find_repository']),
	...waitProperties('repository', ['add_documents_to_repository']),
];

export const searchProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['search'] } },
		options: [
			{
				name: 'Search Documents',
				value: 'search_documents',
				action: 'Search your documents',
				description: 'Search the documents in your Wordsmith repositories',
			},
			{
				name: 'Search Legal Sources',
				value: 'search_legal_sources',
				action: 'Search legal sources',
				description: 'Search case law, legislation and regulators’ publications',
			},
			{
				name: 'Get Legal Source Document',
				value: 'get_legal_source_document',
				action: 'Get a legal source document',
				description: 'Get the text of a document that Search Legal Sources found',
			},
		],
		default: 'search_documents',
	},
	{
		displayName: 'Search For',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. limitation of liability for data breaches',
		description: 'A question or a phrase, up to 1,000 characters',
		displayOptions: show('search', ['search_documents', 'search_legal_sources']),
	},
	{
		displayName: 'Source',
		name: 'source',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. uk_case_law',
		description: 'The source field of a Search Legal Sources result',
		displayOptions: show('search', ['get_legal_source_document']),
	},
	{
		displayName: 'Document ID',
		name: 'documentId',
		type: 'string',
		required: true,
		default: '',
		description: 'The document_id field of a Search Legal Sources result',
		displayOptions: show('search', ['get_legal_source_document']),
	},
	{
		displayName: 'Maximum Characters',
		name: 'maxChars',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 100000 },
		default: 20000,
		description: 'How much text to return, up to 100,000 characters',
		displayOptions: show('search', ['get_legal_source_document']),
	},
	{
		displayName: 'Start At Character',
		name: 'offset',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 0,
		description:
			'Where to start reading. Pass the previous result’s next_offset to read the next part.',
		displayOptions: show('search', ['get_legal_source_document']),
	},
	{
		displayName: 'Repository IDs',
		name: 'repositoryIds',
		type: 'string',
		default: '',
		placeholder: 'e.g. 3c1f2a9e-…, 9a2b7c1d-…',
		description:
			'Comma-separated repositories to search, up to 20. Leave empty to search your 20 most recently active repositories.',
		displayOptions: show('search', ['search_documents']),
	},
	{
		displayName: 'Options',
		name: 'researchOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('search', ['search_legal_sources']),
		options: [
			{ displayName: 'From', name: 'dateFrom', type: 'dateTime', default: '' },
			{
				displayName: 'Jurisdictions',
				name: 'jurisdictions',
				type: 'string',
				default: '',
				placeholder: 'e.g. gb, eu, us',
				description: 'Comma-separated two-letter country codes, or eu',
			},
			{ displayName: 'To', name: 'dateTo', type: 'dateTime', default: '' },
		],
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 50 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: show('search', ['search_documents', 'search_legal_sources']),
	},
];

export const conversationProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['conversation'] } },
		options: [
			{
				name: 'Find',
				value: 'find_conversation',
				action: 'Find a conversation',
				description: 'Get the conversations whose title contains your search',
			},
			{
				name: 'Get Messages',
				value: 'get_conversation_messages',
				action: 'Get the messages in a conversation',
				description: 'Get a conversation’s questions and answers',
			},
		],
		default: 'find_conversation',
	},
	nameContains('conversation', 'find_conversation', 'Title Contains'),
	{
		displayName: 'Conversation ID',
		name: 'sessionId',
		type: 'string',
		required: true,
		default: '',
		description: 'The session_id of a conversation, such as one Ask an Agent returned',
		displayOptions: show('conversation', ['get_conversation_messages']),
	},
	...returnAllAndLimit('conversation', ['find_conversation', 'get_conversation_messages']),
];

export const userProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['user'] } },
		options: [
			{
				name: 'Find',
				value: 'find_user',
				action: 'Find a user',
				description:
					'Get the people in your organisation with this email, or whose name contains it',
			},
		],
		default: 'find_user',
	},
	nameContains('user', 'find_user', 'Email or Name'),
];
