import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

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
			displayName: 'Region',
			name: 'region',
			type: 'options',
			options: [
				{
					name: 'Europe',
					value: 'eu',
				},
				{
					name: 'United States',
					value: 'us',
				},
				{
					name: 'Custom Host',
					value: 'custom',
				},
			],
			default: 'eu',
			description:
				'The region your Wordsmith organisation is hosted in. If you are not sure, ask your Wordsmith admin.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'e.g. https://staging.api.wordsmith.ai',
			description: 'An https host on wordsmith.ai, without /api/v1. Any other host is refused.',
			displayOptions: {
				show: {
					region: ['custom'],
				},
			},
		},
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
			// A custom host must be https on wordsmith.ai; anything else resolves to a host that fails the test.
			baseURL:
				'={{ $credentials.region === "us" ? "https://api.us.wordsmith.ai" : $credentials.region === "custom" ? (/^https:\\/\\/([a-z0-9-]+\\.)*wordsmith\\.ai\\/?$/i.test(String($credentials.baseUrl).trim()) ? String($credentials.baseUrl).trim().replace(/\\/+$/, "") : "https://invalid-base-url.wordsmith.ai") : "https://api.wordsmith.ai" }}/api/v1',
			url: '/me',
		},
	};
}
