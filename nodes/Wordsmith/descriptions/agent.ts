import type { INodeProperties } from 'n8n-workflow';

import { filesOptions, locatorModes, show, waitProperties } from './common';

const agentLocator = (operations: string[], description: string): INodeProperties => ({
	displayName: 'Agent',
	name: 'agent',
	type: 'resourceLocator',
	required: true,
	default: { mode: 'list', value: 'default' },
	description,
	modes: locatorModes('searchAgents'),
	displayOptions: show('agent', operations),
});

export const agentProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['agent'] } },
		options: [
			{
				name: 'Ask',
				value: 'ask_agent',
				action: 'Ask an agent',
				description:
					'Ask a Wordsmith agent a question or give it an instruction, with optional files, and wait for the answer',
			},
			{
				name: 'Find',
				value: 'find_agent',
				action: 'Find an agent',
				description: 'Get the agents whose name contains your search',
			},
			{
				name: 'Get Answer',
				value: 'get_question',
				action: 'Get an answer',
				description: 'Get a question you asked an agent, with its answer if it is ready',
			},
		],
		default: 'ask_agent',
	},
	agentLocator(['ask_agent'], 'The agent to ask. Choose Wordsmith for the general agent.'),
	agentLocator(['get_question'], 'The agent the question was asked of'),
	{
		displayName: 'Question',
		name: 'question',
		type: 'string',
		required: true,
		typeOptions: { rows: 4 },
		default: '',
		placeholder: 'e.g. Summarise the attached contract and list its termination rights',
		description: 'What you want the agent to do, up to 10,000 characters',
		displayOptions: show('agent', ['ask_agent']),
	},
	{
		displayName: 'Question ID',
		name: 'questionId',
		type: 'string',
		required: true,
		default: '',
		description: 'The ID Ask an Agent returned',
		displayOptions: show('agent', ['get_question']),
	},
	...waitProperties('agent', ['ask_agent']),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('agent', ['ask_agent']),
		options: [
			{
				displayName: 'Conversation ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description:
					'Continue the conversation from an earlier answer: its session_id. Leave empty to start a new one.',
			},
			{
				displayName: 'Download Answer Files',
				name: 'downloadAnswerFiles',
				type: 'boolean',
				default: false,
				description:
					'Whether to download the files the agent created, such as a redline, into the output’s binary fields',
			},
			...filesOptions('Up to 10 files for the agent to read.'),
			{
				displayName: 'Who Can See the Conversation',
				name: 'visibility',
				type: 'options',
				options: [
					{ name: 'Only Me', value: 'private' },
					{ name: 'Everyone in My Organisation', value: 'organization' },
				],
				default: 'private',
			},
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('agent', ['get_question']),
		options: [
			{
				displayName: 'Download Answer Files',
				name: 'downloadAnswerFiles',
				type: 'boolean',
				default: false,
				description:
					'Whether to download the files the agent created, such as a redline, into the output’s binary fields',
			},
		],
	},
	{
		displayName: 'Name Contains',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. NDA',
		displayOptions: show('agent', ['find_agent']),
	},
];
