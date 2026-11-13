import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

import { apiHostExpression, appHostExpression } from '../nodes/shared/hosts';

const API_HOST = apiHostExpression('$self');
const APP_HOST = appHostExpression('$self');

// The scopes the Wordsmith nodes use, for a client id entered by hand. Automatic registration replaces them with
// the scopes the API lists for /api/v1, which cover these, webhooks included.
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
	'repositories:write',
	'reports:write',
	'research:read',
	'webhooks:read',
	'webhooks:write',
];

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
		{
			displayName: 'App Host',
			name: 'appHost',
			type: 'string',
			default: 'https://app.wordsmith.ai',
			description:
				'The Wordsmith web app where you sign in, as an https host on wordsmith.ai. Change it only for a test environment.',
			displayOptions: { show: { useCustomHost: [true] } },
		},
		// 0.2.0 stored a region and custom hosts. They stay hidden so a credential saved then keeps its hosts.
		{ displayName: 'Region', name: 'region', type: 'hidden', default: 'eu' },
		{ displayName: 'Base URL', name: 'baseUrl', type: 'hidden', default: '' },
		{ displayName: 'App URL', name: 'appUrl', type: 'hidden', default: '' },
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
