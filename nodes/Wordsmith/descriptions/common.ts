import type { INodeProperties, INodePropertyMode } from 'n8n-workflow';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const show = (resource: string, operation: string[]) => ({
	show: { resource: [resource], operation },
});

const mode = (
	displayName: string,
	name: string,
	type: INodePropertyMode['type'],
	extra: Partial<INodePropertyMode> = {},
): INodePropertyMode => ({ displayName, name, type, ...extra });

/** List, ID and Wordsmith-link modes for a resource the app links to. */
export function locatorModes(searchListMethod: string, searchable = true): INodePropertyMode[] {
	return [
		mode('From List', 'list', 'list', { typeOptions: { searchListMethod, searchable } }),
		mode('By ID', 'id', 'string', { placeholder: 'e.g. 5f0c9a12-8e3b-4d71-a6c4-0b2e9f7d3c58' }),
		mode('By URL', 'url', 'string', {
			placeholder: 'e.g. https://app.wordsmith.ai/…/5f0c9a12-8e3b-4d71-a6c4-0b2e9f7d3c58',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: `https://[^/]*wordsmith\\.ai/.*${UUID}.*`,
						errorMessage: 'Paste a Wordsmith link that contains the ID',
					},
				},
			],
			extractValue: { type: 'regex', regex: `(${UUID})` },
		}),
	];
}

/** One file: a binary field of the input item, or the ID of a file already in Wordsmith. */
export function fileInput(
	prefix: string,
	displayName: string,
	description: string,
	displayOptions: INodeProperties['displayOptions'],
): INodeProperties[] {
	return [
		{
			displayName: `${displayName} Source`,
			name: `${prefix}Source`,
			type: 'options',
			options: [
				{ name: 'Binary Field', value: 'binary', description: 'A file from an earlier node' },
				{ name: 'File ID', value: 'id', description: 'A file already in Wordsmith' },
			],
			default: 'binary',
			description,
			displayOptions,
		},
		{
			displayName: `${displayName} Binary Field`,
			name: `${prefix}BinaryField`,
			type: 'string',
			required: true,
			default: 'data',
			hint: 'The name of the input item’s binary field that holds the file',
			displayOptions: {
				show: { ...displayOptions?.show, [`${prefix}Source`]: ['binary'] },
			},
		},
		{
			displayName: `${displayName} File ID`,
			name: `${prefix}Id`,
			type: 'string',
			required: true,
			default: '',
			description: 'The ID of a file in Wordsmith, such as one Upload a File returned',
			displayOptions: { show: { ...displayOptions?.show, [`${prefix}Source`]: ['id'] } },
		},
	];
}

/** Several files: binary fields of the input item and IDs of files already in Wordsmith. */
export function filesOptions(help: string): INodeProperties[] {
	return [
		{
			displayName: 'Binary Fields',
			name: 'binaryFields',
			type: 'string',
			default: '',
			placeholder: 'e.g. data, attachment_0',
			description: `${help} Comma-separated names of the input item’s binary fields; each is uploaded first`,
		},
		{
			displayName: 'File IDs',
			name: 'fileIds',
			type: 'string',
			default: '',
			placeholder: 'e.g. 3c1f2a9e-…, 9a2b7c1d-…',
			description: `${help} Comma-separated IDs of files already in Wordsmith`,
		},
	];
}

/** Wait, Maximum Wait and Callback URL, for actions that start a job. */
export function waitProperties(resource: string, operations: string[]): INodeProperties[] {
	return [
		{
			displayName: 'Wait for Result',
			name: 'waitForResult',
			type: 'boolean',
			default: true,
			description:
				'Whether to wait in this step until Wordsmith has finished. Turn it off to get the job at once, for example to wait with a Wait node.',
			displayOptions: show(resource, operations),
		},
		{
			displayName: 'Maximum Wait (Minutes)',
			name: 'maxWaitMinutes',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 1440 },
			default: 15,
			description:
				'How long to wait. If Wordsmith is still working after this, the step fails and names the job ID, so a later Get a Job step can read the result.',
			displayOptions: {
				show: { resource: [resource], operation: operations, waitForResult: [true] },
			},
		},
		{
			displayName: 'Callback URL',
			name: 'callbackUrl',
			type: 'string',
			default: '',
			placeholder: 'e.g. {{ $execution.resumeUrl }}',
			description:
				'An https URL that Wordsmith calls when the job ends. Use {{ $execution.resumeUrl }} with a Wait node set to resume on a webhook call.',
			// Wordsmith signs callbacks with an API key's webhook secret, so OAuth connections cannot use them.
			displayOptions: {
				show: {
					resource: [resource],
					operation: operations,
					waitForResult: [false],
					authentication: ['apiKey'],
				},
			},
		},
	];
}

/** Where to put a downloaded file. */
export function outputBinaryField(resource: string, operations: string[]): INodeProperties {
	return {
		displayName: 'Put Output File in Field',
		name: 'outputBinaryField',
		type: 'string',
		default: 'data',
		hint: 'The name of the output binary field for the file Wordsmith produced',
		displayOptions: { show: { resource: [resource], operation: operations } },
	};
}

export const returnAllAndLimit = (resource: string, operations: string[]): INodeProperties[] => [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: show(resource, operations),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { resource: [resource], operation: operations, returnAll: [false] } },
	},
];
