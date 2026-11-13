import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { apiHostExpression } from '../nodes/shared/hosts';

export class WordsmithApi implements ICredentialType {
	name = 'wordsmithApi';

	displayName = 'Wordsmith API';

	icon: Icon = {
		light: 'file:../nodes/Wordsmith/wordsmith.svg',
		dark: 'file:../nodes/Wordsmith/wordsmith.dark.svg',
	};

	documentationUrl =
		'https://github.com/wordsmith-ai/n8n-nodes-wordsmith?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create an API key in Wordsmith under Settings → API keys. The connection acts with the access of the person who created the key. For automations that serve a whole team, create the key as a user who can see that team’s work.',
		},
		{
			displayName: 'Use a Custom Host',
			name: 'useCustomHost',
			type: 'boolean',
			default: false,
			description:
				'Whether to call a specific Wordsmith host. Leave it off: the default host reaches every Wordsmith organisation. Turn it on to keep requests in the US region, for example for data residency, or to use a test environment.',
		},
		{
			displayName: 'API Host',
			name: 'apiHost',
			type: 'string',
			default: 'https://api.wordsmith.ai',
			description:
				'An https host on wordsmith.ai, without /api/v1. Use https://api.us.wordsmith.ai for the US region.',
			displayOptions: { show: { useCustomHost: [true] } },
		},
		// 0.2.0 stored a region and a custom host. They stay hidden so a credential saved then keeps its host.
		{ displayName: 'Region', name: 'region', type: 'hidden', default: 'eu' },
		{ displayName: 'Base URL', name: 'baseUrl', type: 'hidden', default: '' },
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			// A host off https wordsmith.ai resolves to one that fails the test, so the key never goes elsewhere.
			baseURL: `={{ ${apiHostExpression('$credentials')} }}/api/v1`,
			url: '/me',
		},
	};
}
