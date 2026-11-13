import type { INodeProperties } from 'n8n-workflow';

import {
	filesOptions,
	locatorModes,
	outputBinaryField,
	returnAllAndLimit,
	show,
	waitProperties,
} from './common';

export const reviewProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['review'] } },
		options: [
			{
				name: 'Create Redline',
				value: 'generate_review_redline',
				action: 'Create a redline from a review',
				description: 'Turn a review’s findings into tracked changes on the reviewed document',
			},
			{
				name: 'Find',
				value: 'get_review',
				action: 'Find a review',
				description: 'Get a review by its ID, or the latest review that matches your search',
			},
			{
				name: 'Run',
				value: 'run_review',
				action: 'Review a document',
				description:
					'Review contracts against a playbook or your own instructions, or review the other side’s edits',
			},
		],
		default: 'run_review',
	},
	{
		displayName: 'Review Type',
		name: 'reviewType',
		type: 'options',
		required: true,
		options: [
			{ name: 'Against a Playbook', value: 'playbook' },
			{ name: 'Against Instructions', value: 'instructions' },
			{ name: 'The Other Side’s Edits', value: 'counterparty_edits' },
		],
		default: 'playbook',
		displayOptions: show('review', ['run_review']),
	},
	{
		displayName: 'Documents',
		name: 'documents',
		type: 'collection',
		placeholder: 'Add Documents',
		default: { binaryFields: 'data' },
		required: true,
		description:
			'Up to 10 Word or PDF files. For the other side’s edits, one Word document with tracked changes.',
		displayOptions: show('review', ['run_review']),
		options: filesOptions('The documents to review.'),
	},
	{
		displayName: 'Playbook',
		name: 'playbook',
		type: 'resourceLocator',
		required: true,
		default: { mode: 'list', value: '' },
		description: 'The playbook to review against',
		modes: locatorModes('searchPlaybooks'),
		displayOptions: {
			show: { resource: ['review'], operation: ['run_review'], reviewType: ['playbook'] },
		},
	},
	{
		displayName: 'Instructions',
		name: 'instructions',
		type: 'string',
		required: true,
		typeOptions: { rows: 4 },
		default: '',
		placeholder: 'e.g. Flag any uncapped liability and any auto-renewal longer than a year',
		description: 'What to check, in plain language, up to 10,000 characters',
		displayOptions: {
			show: { resource: ['review'], operation: ['run_review'], reviewType: ['instructions'] },
		},
	},
	{
		displayName: 'Acting For',
		name: 'party',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Customer',
		description: 'The party you act for, so the review knows whose edits to question',
		displayOptions: {
			show: { resource: ['review'], operation: ['run_review'], reviewType: ['counterparty_edits'] },
		},
	},
	{
		displayName: 'Review ID',
		name: 'reviewId',
		type: 'string',
		required: true,
		default: '',
		description: 'The ID of a finished review, such as one Review a Document returned',
		displayOptions: show('review', ['generate_review_redline']),
	},
	{
		displayName: 'Finding IDs',
		name: 'findingIds',
		type: 'string',
		default: '',
		placeholder: 'e.g. 3c1f2a9e-…, 9a2b7c1d-…',
		description:
			'Comma-separated findings to apply. Leave empty to use every finding with a recommendation.',
		displayOptions: show('review', ['generate_review_redline']),
	},
	...waitProperties('review', ['run_review', 'generate_review_redline']),
	{
		...outputBinaryField('review', ['generate_review_redline']),
		displayOptions: {
			show: {
				resource: ['review'],
				operation: ['generate_review_redline'],
				waitForResult: [true],
			},
		},
	},
	{
		displayName: 'Download Redline',
		name: 'downloadRedline',
		type: 'boolean',
		default: true,
		description: 'Whether to download the review’s redline, when it has one, into a binary field',
		displayOptions: {
			show: { resource: ['review'], operation: ['run_review'], waitForResult: [true] },
		},
	},
	{
		...outputBinaryField('review', ['run_review']),
		displayOptions: {
			show: {
				resource: ['review'],
				operation: ['run_review'],
				waitForResult: [true],
				downloadRedline: [true],
			},
		},
	},
	{
		displayName: 'Review ID',
		name: 'reviewId',
		type: 'string',
		default: '',
		description: 'The review’s ID. Leave empty to search by name instead.',
		displayOptions: show('review', ['get_review']),
	},
	{
		displayName: 'Name Contains',
		name: 'query',
		type: 'string',
		default: '',
		description: 'Find reviews whose name contains this text, newest first',
		displayOptions: { show: { resource: ['review'], operation: ['get_review'], reviewId: [''] } },
	},
	...returnAllAndLimit('review', ['get_review']).map((property) => ({
		...property,
		displayOptions: {
			show: { ...property.displayOptions?.show, reviewId: [''] },
		},
	})),
];

export const draftProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['draft'] } },
		options: [
			{
				name: 'Create',
				value: 'draft_document',
				action: 'Draft a document',
				description: 'Draft a new document from instructions, or from one of your blueprints',
			},
		],
		default: 'draft_document',
	},
	{
		displayName: 'Blueprint',
		name: 'blueprint',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		description: 'Start from one of your blueprints. Leave empty to draft from instructions alone.',
		modes: locatorModes('searchBlueprints'),
		displayOptions: show('draft', ['draft_document']),
	},
	{
		displayName: 'Blueprint Fields',
		name: 'values',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		description: 'One field per placeholder in the blueprint. Empty fields are drafted by AI.',
		typeOptions: {
			loadOptionsDependsOn: ['blueprint.value'],
			resourceMapper: {
				resourceMapperMethod: 'getBlueprintFields',
				mode: 'add',
				fieldWords: { singular: 'field', plural: 'fields' },
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: false,
			},
		},
		displayOptions: show('draft', ['draft_document']),
	},
	{
		displayName: 'Instructions',
		name: 'instructions',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		placeholder: 'e.g. A mutual NDA between Acme Ltd and Beta GmbH under English law',
		description:
			'What to draft. Required without a blueprint; with one, it steers how AI drafts the fields you leave empty.',
		displayOptions: show('draft', ['draft_document']),
	},
	{
		displayName: 'Options',
		name: 'draftOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('draft', ['draft_document']),
		options: [
			{
				displayName: 'Background',
				name: 'context',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Facts the draft should reflect',
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				description: 'The new file’s name, without an extension',
			},
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				options: [
					{ name: 'Word', value: 'docx' },
					{ name: 'PDF', value: 'pdf' },
				],
				default: 'docx',
			},
			...filesOptions('Up to 10 reference files.'),
		],
	},
	...waitProperties('draft', ['draft_document']),
	{
		...outputBinaryField('draft', ['draft_document']),
		displayOptions: {
			show: { resource: ['draft'], operation: ['draft_document'], waitForResult: [true] },
		},
	},
];
