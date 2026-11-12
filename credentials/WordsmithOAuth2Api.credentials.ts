import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

// The scopes the Wordsmith nodes use. Webhook scopes are never granted by default, so they are named here for the
// Wordsmith Trigger.
const SCOPES = [
	'me:read',
	'agents:read',
	'sessions:write',
	'files:read',
	'files:write',
	'reviews:write',
	'playbooks:read',
	'blueprints:read',
	'tasks:write',
	'directory:read',
	'webhooks:read',
	'webhooks:write',
];

// A custom host must be https on wordsmith.ai; anything else resolves to a host that fails, so the client secret
// and tokens never go elsewhere.
const ON_WORDSMITH = '/^https:\\/\\/([a-z0-9-]+\\.)*wordsmith\\.ai\\/?$/i';
const API_HOST = `($self["region"] === "us" ? "https://api.us.wordsmith.ai" : $self["region"] === "custom" ? (${ON_WORDSMITH}.test(String($self["baseUrl"]).trim()) ? String($self["baseUrl"]).trim().replace(/\\/+$/, "") : "https://invalid-base-url.wordsmith.ai") : "https://api.wordsmith.ai")`;
const APP_HOST = `($self["region"] === "custom" ? (${ON_WORDSMITH}.test(String($self["appUrl"]).trim()) ? String($self["appUrl"]).trim().replace(/\\/+$/, "") : "https://invalid-app-url.wordsmith.ai") : "https://app.wordsmith.ai")`;

export class WordsmithOAuth2Api implements ICredentialType {
	name = 'wordsmithOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'Wordsmith OAuth2 API';

	icon: Icon = {
		light: 'file:../nodes/Wordsmith/wordsmith.svg',
		dark: 'file:../nodes/Wordsmith/wordsmith.dark.svg',
	};

	documentationUrl =
		'https://github.com/wordsmith-ai/n8n-nodes-wordsmith?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			// n8n registers itself with Wordsmith (RFC 7591) as a public PKCE client, so nobody types a client id. The
			// redirect URL must be one Wordsmith allows, which n8n Cloud's are.
			displayName: 'Register Client Automatically',
			name: 'useDynamicClientRegistration',
			type: 'boolean',
			default: true,
			description:
				'Whether n8n registers itself with Wordsmith. Keep it on for n8n Cloud. On self-hosted n8n, turn it off and enter the client ID of an app your Wordsmith admin added under Settings → App access.',
		},
		{
			// Where n8n discovers the authorization server and the resource when it registers itself.
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'hidden',
			default: `={{ ${API_HOST} + "/api/v1" }}`,
		},
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'pkce',
		},
		{
			displayName: 'Region',
			name: 'region',
			type: 'options',
			options: [
				{ name: 'Europe', value: 'eu' },
				{ name: 'United States', value: 'us' },
				{ name: 'Custom Host', value: 'custom' },
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
			description: 'An https API host on wordsmith.ai, without /api/v1. Any other host is refused.',
			displayOptions: { show: { region: ['custom'] } },
		},
		{
			displayName: 'App URL',
			name: 'appUrl',
			type: 'string',
			default: '',
			placeholder: 'e.g. https://staging.app.wordsmith.ai',
			description: 'The Wordsmith web app host where people sign in, on wordsmith.ai',
			displayOptions: { show: { region: ['custom'] } },
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: `={{ ${APP_HOST} + "/oauth/authorize" }}`,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: `={{ ${API_HOST} + "/oauth/token" }}`,
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: SCOPES.join(' '),
		},
		{
			// The resource indicator makes the token's audience the REST API rather than the MCP server. n8n sends it
			// on the authorize, token and refresh calls.
			displayName: 'Resource URL',
			name: 'resourceUrl',
			type: 'hidden',
			default: `={{ ${API_HOST} + "/api/v1" }}`,
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
		{
			// For a client id entered by hand: a public app has no secret, so the client id has to travel in the body,
			// and a company app's secret goes there too (client_secret_post). Automatic registration sets its own.
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'The app’s secret, if it has one. A public app uses PKCE and has none.',
			displayOptions: { show: { useDynamicClientRegistration: [false] } },
		},
	];
}
