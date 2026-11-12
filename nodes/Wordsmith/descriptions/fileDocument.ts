import type { INodeProperties } from 'n8n-workflow';

import { fileInput, outputBinaryField, show, waitProperties } from './common';

export const fileProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['file'] } },
		options: [
			{
				name: 'Get',
				value: 'get_file',
				action: 'Get a file',
				description: 'Get a Wordsmith file and its contents, to use in later steps',
			},
			{
				name: 'Upload',
				value: 'upload_file',
				action: 'Upload a file',
				description: 'Store a file in your private Wordsmith space, to use in later steps',
			},
		],
		default: 'upload_file',
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		hint: 'The name of the input item’s binary field that holds the file',
		displayOptions: show('file', ['upload_file']),
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		placeholder: 'e.g. contract.pdf',
		description: 'Defaults to the file’s own name',
		displayOptions: show('file', ['upload_file']),
	},
	{
		displayName: 'File ID',
		name: 'fileId',
		type: 'string',
		required: true,
		default: '',
		description: 'The ID of a file in Wordsmith',
		displayOptions: show('file', ['get_file']),
	},
	outputBinaryField('file', ['get_file']),
];

const DOCUMENT_OPS = ['redline_document', 'compare_documents', 'convert_document'];

export const documentProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['document'] } },
		options: [
			{
				name: 'Compare',
				value: 'compare_documents',
				action: 'Compare two documents',
				description: 'Show the changes between two versions of a document as tracked changes',
			},
			{
				name: 'Convert',
				value: 'convert_document',
				action: 'Convert a document',
				description: 'Convert a Word document to PDF, or a PDF to Word',
			},
			{
				name: 'Redline',
				value: 'redline_document',
				action: 'Redline a document',
				description:
					'Make edits to a Word document as tracked changes, from instructions in plain language',
			},
		],
		default: 'redline_document',
	},
	...fileInput(
		'document',
		'Document',
		'The document to work on',
		show('document', ['redline_document', 'convert_document']),
	),
	{
		displayName: 'Instructions',
		name: 'instructions',
		type: 'string',
		required: true,
		typeOptions: { rows: 4 },
		default: '',
		placeholder: 'e.g. Cap liability at 12 months of fees and make the governing law English',
		description: 'What to change, up to 10,000 characters',
		displayOptions: show('document', ['redline_document']),
	},
	{
		displayName: 'Options',
		name: 'redlineOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('document', ['redline_document']),
		options: [
			{
				displayName: 'Acting For',
				name: 'actingParty',
				type: 'string',
				default: '',
				placeholder: 'e.g. Buyer',
				description: 'The party you act for, such as Buyer',
			},
			{
				displayName: 'Author Name',
				name: 'authorName',
				type: 'string',
				default: '',
				description: 'The name shown on the tracked changes',
			},
		],
	},
	...fileInput(
		'original',
		'Original',
		'The earlier version',
		show('document', ['compare_documents']),
	),
	...fileInput(
		'revised',
		'Revised Version',
		'The later version',
		show('document', ['compare_documents']),
	),
	{
		displayName: 'Output Format',
		name: 'outputFormat',
		type: 'options',
		options: [
			{ name: 'Word', value: 'docx' },
			{ name: 'PDF', value: 'pdf' },
		],
		default: 'docx',
		displayOptions: show('document', ['compare_documents']),
	},
	{
		displayName: 'Convert To',
		name: 'targetFormat',
		type: 'options',
		required: true,
		options: [
			{ name: 'PDF', value: 'pdf' },
			{ name: 'Word', value: 'docx' },
		],
		default: 'pdf',
		displayOptions: show('document', ['convert_document']),
	},
	...waitProperties('document', DOCUMENT_OPS),
	{
		...outputBinaryField('document', DOCUMENT_OPS),
		displayOptions: {
			show: { resource: ['document'], operation: DOCUMENT_OPS, waitForResult: [true] },
		},
	},
];
