import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { WordsmithOAuth2Api } = require('../dist/credentials/WordsmithOAuth2Api.credentials.js');
const { WordsmithApi } = require('../dist/credentials/WordsmithApi.credentials.js');
const { apiBaseUrl, credentialName } = require('../dist/nodes/shared/transport.js');
const { OPERATIONS } = require('../dist/nodes/Wordsmith/actions.js');
const { Wordsmith } = require('../dist/nodes/Wordsmith/Wordsmith.node.js');
const { WordsmithTrigger } = require('../dist/nodes/WordsmithTrigger/WordsmithTrigger.node.js');
const {
	WordsmithPollingTrigger,
} = require('../dist/nodes/WordsmithPollingTrigger/WordsmithPollingTrigger.node.js');

/** Evaluates one of the credential's `={{ … }}` defaults the way n8n would, with `$self` as the credential. */
function evaluate(name, self) {
	const property = new WordsmithOAuth2Api().properties.find((p) => p.name === name);
	const expression = property.default.replace(/^=\{\{/, '').replace(/\}\}$/, '');
	return new Function('$self', `return (${expression});`)(self);
}

describe('Wordsmith API credential test', () => {
	const testBase = (credentials) => {
		const expression = new WordsmithApi().test.request.baseURL
			.replace(/^=\{\{/, '')
			.replace(/\}\}\/api\/v1$/, '');
		return new Function('$credentials', `return (${expression});`)(credentials);
	};

	it('tests against the EU host, the API Host, or a 0.2.0 credential’s region', () => {
		const shown = new WordsmithApi().properties.filter((p) => p.type !== 'hidden');
		assert.ok(!shown.some((p) => ['region', 'baseUrl'].includes(p.name)));
		assert.equal(testBase({}), 'https://api.wordsmith.ai');
		assert.equal(
			testBase({ useCustomHost: true, apiHost: 'https://api.us.wordsmith.ai' }),
			'https://api.us.wordsmith.ai',
		);
		assert.equal(testBase({ region: 'us' }), 'https://api.us.wordsmith.ai');
		assert.ok(
			testBase({ useCustomHost: true, apiHost: 'https://evil.example.com' }).startsWith(
				'https://invalid-',
			),
		);
	});
});

describe('the credential expressions and the request helper agree', () => {
	const testBase = (credentials) => {
		const expression = new WordsmithApi().test.request.baseURL
			.replace(/^=\{\{/, '')
			.replace(/\}\}\/api\/v1$/, '');
		return new Function('$credentials', `return (${expression});`)(credentials);
	};
	const requestBase = (credentials) => {
		try {
			return apiBaseUrl(credentials).replace(/\/api\/v1$/, '');
		} catch {
			return 'refused';
		}
	};
	const credentialBase = (credentials) => {
		const base = testBase(credentials);
		return base.startsWith('https://invalid-') ? 'refused' : base;
	};

	const cases = [
		[{}, 'https://api.wordsmith.ai'],
		[{ useCustomHost: false, apiHost: 'https://api.us.wordsmith.ai' }, 'https://api.wordsmith.ai'],
		[{ apiHost: 'https://api.us.wordsmith.ai' }, 'https://api.wordsmith.ai'],
		[{ useCustomHost: true, apiHost: '' }, 'refused'],
		[{ useCustomHost: true, apiHost: '  ', region: 'us' }, 'refused'],
		[{ useCustomHost: true }, 'refused'],
		// With the toggle on, the API Host is used as entered, over a 0.2.0 credential's saved host.
		[
			{ useCustomHost: true, apiHost: 'https://api.wordsmith.ai', region: 'us' },
			'https://api.wordsmith.ai',
		],
		[
			{
				useCustomHost: true,
				apiHost: 'https://api.wordsmith.ai',
				region: 'custom',
				baseUrl: 'http://bad',
			},
			'https://api.wordsmith.ai',
		],
		[
			{ useCustomHost: true, apiHost: 'https://api.us.wordsmith.ai' },
			'https://api.us.wordsmith.ai',
		],
		[
			{ useCustomHost: true, apiHost: ' https://API.us.wordsmith.ai/ ' },
			'https://api.us.wordsmith.ai',
		],
		[
			{ useCustomHost: true, apiHost: 'https://api.us.wordsmith.ai/api/v1' },
			'https://api.us.wordsmith.ai',
		],
		[
			{ useCustomHost: true, apiHost: 'https://api.us.wordsmith.ai:443' },
			'https://api.us.wordsmith.ai',
		],
		[
			{ useCustomHost: true, apiHost: 'https://api.us.wordsmith.ai:443/api/v1' },
			'https://api.us.wordsmith.ai',
		],
		[{ useCustomHost: true, apiHost: 'https://wordsmith.ai.:443' }, 'refused'],
		[
			{ useCustomHost: true, apiHost: 'https://staging.api.wordsmith.ai:8443/x' },
			'https://staging.api.wordsmith.ai:8443',
		],
		[{ useCustomHost: true, apiHost: 'http://api.wordsmith.ai' }, 'refused'],
		[{ useCustomHost: true, apiHost: 'https://evil.example.com' }, 'refused'],
		[{ useCustomHost: true, apiHost: 'https://wordsmith.ai.evil.com' }, 'refused'],
		[{ useCustomHost: true, apiHost: 'https://user:pass@api.wordsmith.ai' }, 'refused'],
		[
			{ useCustomHost: true, apiHost: 'https://api.us.wordsmith.ai', region: 'eu' },
			'https://api.us.wordsmith.ai',
		],
		[
			{ useCustomHost: true, apiHost: 'https://staging.api.wordsmith.ai', region: 'us' },
			'https://staging.api.wordsmith.ai',
		],
		[
			{
				useCustomHost: true,
				apiHost: 'https://staging.api.wordsmith.ai',
				region: 'custom',
				baseUrl: 'https://other.wordsmith.ai',
			},
			'https://staging.api.wordsmith.ai',
		],
		[
			{ useCustomHost: false, apiHost: 'https://staging.api.wordsmith.ai', region: 'us' },
			'https://api.us.wordsmith.ai',
		],
		[
			{ region: 'custom', baseUrl: 'https://staging.api.wordsmith.ai/' },
			'https://staging.api.wordsmith.ai',
		],
		[{ region: 'custom', baseUrl: 'https://evil.example.com' }, 'refused'],
	];

	for (const [credentials, expected] of cases) {
		it(`resolves ${JSON.stringify(credentials)} to ${expected}`, () => {
			assert.equal(requestBase(credentials), expected);
			assert.equal(credentialBase(credentials), expected);
			if (expected !== 'refused') {
				assert.equal(evaluate('resourceUrl', credentials), `${expected}/api/v1`);
			}
		});
	}

	it('shows the host fields, pre-filled, only when Use a Custom Host is on', () => {
		for (const credential of [new WordsmithApi(), new WordsmithOAuth2Api()]) {
			const field = (name) => credential.properties.find((p) => p.name === name);
			assert.equal(field('useCustomHost').default, false);
			assert.equal(field('apiHost').default, 'https://api.wordsmith.ai');
			assert.deepEqual(field('apiHost').displayOptions.show.useCustomHost, [true]);
		}
		const appHost = new WordsmithOAuth2Api().properties.find((p) => p.name === 'appHost');
		assert.equal(appHost.default, 'https://app.wordsmith.ai');
		assert.deepEqual(appHost.displayOptions.show.useCustomHost, [true]);
		assert.equal(
			evaluate('authUrl', { useCustomHost: false, appHost: 'https://staging.app.wordsmith.ai' }),
			'https://app.wordsmith.ai/oauth/authorize',
		);
		const savedStaging = {
			region: 'custom',
			baseUrl: 'https://staging.api.wordsmith.ai',
			appUrl: 'https://staging.app.wordsmith.ai',
		};
		assert.equal(
			evaluate('authUrl', savedStaging),
			'https://staging.app.wordsmith.ai/oauth/authorize',
		);
		assert.equal(
			evaluate('authUrl', {
				...savedStaging,
				useCustomHost: true,
				apiHost: 'https://api.wordsmith.ai',
				appHost: 'https://app.wordsmith.ai',
			}),
			'https://app.wordsmith.ai/oauth/authorize',
		);
	});

	it('keeps the 0.2.0 fields defined and hidden, so n8n still returns their stored values', () => {
		const types = (credential) =>
			Object.fromEntries(credential.properties.map((p) => [p.name, p.type]));
		assert.deepEqual(
			[types(new WordsmithApi()).region, types(new WordsmithApi()).baseUrl],
			['hidden', 'hidden'],
		);
		const oauth = types(new WordsmithOAuth2Api());
		assert.deepEqual([oauth.region, oauth.baseUrl, oauth.appUrl], ['hidden', 'hidden', 'hidden']);
	});
});

describe('Wordsmith OAuth2 credential', () => {
	it('shows no region: a new credential uses the EU host, which reaches every region', () => {
		const shown = new WordsmithOAuth2Api().properties.filter((p) => p.type !== 'hidden');
		assert.ok(!shown.some((p) => ['region', 'baseUrl', 'appUrl'].includes(p.name)));
		assert.equal(evaluate('accessTokenUrl', {}), 'https://api.wordsmith.ai/oauth/token');
		assert.equal(evaluate('resourceUrl', {}), 'https://api.wordsmith.ai/api/v1');
		assert.equal(evaluate('authUrl', {}), 'https://app.wordsmith.ai/oauth/authorize');
	});

	it('uses the API Host and App Host when set, on https wordsmith.ai only', () => {
		const staging = {
			useCustomHost: true,
			apiHost: 'https://staging.api.wordsmith.ai/',
			appHost: 'https://staging.app.wordsmith.ai',
		};
		assert.equal(evaluate('serverUrl', staging), 'https://staging.api.wordsmith.ai/api/v1');
		assert.equal(evaluate('authUrl', staging), 'https://staging.app.wordsmith.ai/oauth/authorize');
		const elsewhere = {
			useCustomHost: true,
			apiHost: 'https://evil.example.com',
			appHost: 'http://app.wordsmith.ai',
		};
		assert.ok(evaluate('accessTokenUrl', elsewhere).startsWith('https://invalid-'));
		assert.ok(evaluate('authUrl', elsewhere).startsWith('https://invalid-'));
	});

	it('uses PKCE and the region’s token endpoint and REST resource', () => {
		const credential = new WordsmithOAuth2Api();
		assert.deepEqual(credential.extends, ['oAuth2Api']);
		assert.equal(credential.properties.find((p) => p.name === 'grantType').default, 'pkce');
		assert.equal(evaluate('authUrl', { region: 'eu' }), 'https://app.wordsmith.ai/oauth/authorize');
		assert.equal(
			evaluate('accessTokenUrl', { region: 'eu' }),
			'https://api.wordsmith.ai/oauth/token',
		);
		assert.equal(
			evaluate('accessTokenUrl', { region: 'us' }),
			'https://api.us.wordsmith.ai/oauth/token',
		);
		assert.equal(evaluate('resourceUrl', { region: 'us' }), 'https://api.us.wordsmith.ai/api/v1');
	});

	it('accepts a custom host only on https wordsmith.ai', () => {
		const staging = {
			region: 'custom',
			baseUrl: 'https://staging.api.us.wordsmith.ai/',
			appUrl: 'https://staging.app.wordsmith.ai',
		};
		assert.equal(
			evaluate('accessTokenUrl', staging),
			'https://staging.api.us.wordsmith.ai/oauth/token',
		);
		assert.equal(evaluate('authUrl', staging), 'https://staging.app.wordsmith.ai/oauth/authorize');
		const elsewhere = {
			region: 'custom',
			baseUrl: 'https://evil.example.com',
			appUrl: 'http://app.wordsmith.ai',
		};
		assert.ok(!evaluate('accessTokenUrl', elsewhere).includes('example.com'));
		assert.ok(evaluate('authUrl', elsewhere).startsWith('https://invalid-'));
	});

	it('registers itself by default, discovering from the region’s REST resource', () => {
		const properties = new WordsmithOAuth2Api().properties;
		assert.equal(properties.find((p) => p.name === 'useDynamicClientRegistration').default, true);
		assert.equal(evaluate('serverUrl', { region: 'eu' }), 'https://api.wordsmith.ai/api/v1');
		assert.equal(evaluate('serverUrl', { region: 'us' }), 'https://api.us.wordsmith.ai/api/v1');
	});

	it('takes a company app’s client by hand: the secret is optional and goes in the body', () => {
		const properties = new WordsmithOAuth2Api().properties;
		const secret = properties.find((p) => p.name === 'clientSecret');
		assert.notEqual(secret.required, true);
		assert.deepEqual(secret.displayOptions.show.useDynamicClientRegistration, [false]);
		assert.equal(properties.find((p) => p.name === 'authentication').default, 'body');
	});

	it('asks for the scopes the trigger needs, webhooks included', () => {
		const scope = new WordsmithOAuth2Api().properties
			.find((p) => p.name === 'scope')
			.default.split(' ');
		for (const needed of [
			'webhooks:read',
			'webhooks:write',
			'sessions:write',
			'reviews:write',
			'tasks:write',
			'repositories:write',
			'reports:write',
			'research:read',
		]) {
			assert.ok(scope.includes(needed), needed);
		}
	});
});

describe('Authentication selector', () => {
	it('is on every node: version 1 keeps the API key, version 2 defaults to OAuth2', () => {
		for (const NodeType of [Wordsmith, WordsmithPollingTrigger]) {
			const { properties, credentials, version, defaultVersion } = new NodeType().description;
			assert.deepEqual(version, [1, 2]);
			assert.equal(defaultVersion, 2);
			const byVersion = Object.fromEntries(
				properties
					.filter((p) => p.name === 'authentication')
					.map((p) => [p.displayOptions.show['@version'][0], p]),
			);
			assert.equal(byVersion[1].default, 'apiKey');
			assert.equal(byVersion[2].default, 'oAuth2');
			assert.equal(byVersion[2].options[0].value, 'oAuth2');
			assert.deepEqual(
				credentials.map((c) => [c.name, c.displayOptions.show.authentication[0]]),
				[
					['wordsmithOAuth2Api', 'oAuth2'],
					['wordsmithApi', 'apiKey'],
				],
			);
		}
	});

	it('moves Wordsmith Trigger to OAuth2 in version 3, leaving saved version-2 triggers on their API key', () => {
		const { properties, credentials, version, defaultVersion } = new WordsmithTrigger().description;
		assert.deepEqual(version, [1, 2, 3]);
		assert.equal(defaultVersion, 3);
		const defaults = Object.fromEntries(
			properties
				.filter((p) => p.name === 'authentication')
				.map((p) => [p.displayOptions.show['@version'][0], p.default]),
		);
		assert.deepEqual(defaults, { 1: 'apiKey', 2: 'apiKey', 3: 'oAuth2' });
		assert.deepEqual(
			credentials.map((c) => c.name),
			['wordsmithOAuth2Api', 'wordsmithApi'],
		);
	});

	it('picks the credential the field names', () => {
		const node = (parameters) => ({
			getNodeParameter: (name, fallback) => (name in parameters ? parameters[name] : fallback),
		});
		assert.equal(credentialName.call(node({ authentication: 'apiKey' })), 'wordsmithApi');
		assert.equal(credentialName.call(node({ authentication: 'oAuth2' })), 'wordsmithOAuth2Api');
		// With no value at all, the API key: version 1's default.
		assert.equal(credentialName.call(node({})), 'wordsmithApi');
	});
});

describe('Callback URL on an OAuth connection', () => {
	it('is not sent, because callbacks need an API key', async () => {
		const calls = [];
		const parameters = {
			blueprint: { mode: 'id', value: '' },
			instructions: 'A short NDA',
			draftOptions: {},
			waitForResult: false,
			callbackUrl: 'https://n8n.example.com/webhook-waiting/1',
			authentication: 'oAuth2',
		};
		const ctx = {
			getNodeParameter: (name, _item, fallback, options) => {
				const value = name in parameters ? parameters[name] : fallback;
				return options?.extractValue && value && typeof value === 'object' ? value.value : value;
			},
			getExecutionId: () => 'exec-oauth',
			getWorkflowDataProxy: () => ({ $runIndex: 0 }),
			getNode: () => ({ name: 'Wordsmith' }),
			getInputData: () => [{ json: {} }],
			getCredentials: async () => ({ region: 'eu' }),
			helpers: {
				httpRequestWithAuthentication: async (credential, options) => {
					calls.push({ credential, body: options.body });
					return { statusCode: 202, headers: {}, body: { id: 'op1', status: 'queued' } };
				},
			},
		};
		await OPERATIONS.draft_document.call(ctx, 0, 'draft_document');
		assert.equal(calls[0].credential, 'wordsmithOAuth2Api');
		assert.equal('callback_url' in calls[0].body, false);
	});
});

function apiContext({ authentication, respond, parameters = {} }) {
	const calls = [];
	const values = { authentication, ...parameters };
	return {
		calls,
		getNodeParameter: (name, _item, fallback, options) => {
			const value = name in values ? values[name] : fallback;
			return options?.extractValue && value && typeof value === 'object' ? value.value : value;
		},
		getInputData: () => [{ json: {} }],
		getExecutionId: () => 'exec-auth',
		getWorkflowDataProxy: () => ({ $runIndex: 0 }),
		getNode: () => ({ name: 'Wordsmith', type: 'wordsmith', typeVersion: 2 }),
		getCredentials: async () => ({ region: 'eu' }),
		helpers: {
			httpRequestWithAuthentication: async (credential, options) => {
				calls.push({ credential, options });
				return respond(options);
			},
		},
	};
}

describe('OAuth2 token refresh', () => {
	const { wordsmithApi, errorMessage } = require('../dist/nodes/shared/transport.js');

	it('lets a 401 throw on OAuth2, so n8n refreshes the token, and ignores other statuses', async () => {
		const ctx = apiContext({
			authentication: 'oAuth2',
			respond: () => ({ statusCode: 200, headers: {}, body: { user_id: 'u1' } }),
		});
		await wordsmithApi.call(ctx, 'GET', '/me');
		assert.deepEqual(ctx.calls[0].options.ignoreHttpStatusErrors, { ignore: true, except: [401] });
		const keyed = apiContext({
			authentication: 'apiKey',
			respond: () => ({ statusCode: 200, headers: {}, body: {} }),
		});
		await wordsmithApi.call(keyed, 'GET', '/me');
		assert.equal(keyed.calls[0].options.ignoreHttpStatusErrors, true);
	});

	it('turns a 401 that survives the refresh into an API error', async () => {
		const ctx = apiContext({
			authentication: 'oAuth2',
			respond: () => {
				const error = new Error('Request failed with status code 401');
				error.response = { status: 401, headers: {}, data: { error_code: 'unauthorized' } };
				throw error;
			},
		});
		await assert.rejects(wordsmithApi.call(ctx, 'GET', '/me'), {
			name: 'NodeApiError',
			httpCode: '401',
		});
	});

	const reconnect = errorMessage({ statusCode: 401, headers: {}, body: {} }, 'wordsmithOAuth2Api');
	const failing = (error) =>
		apiContext({
			authentication: 'oAuth2',
			respond: () => {
				throw error;
			},
		});
	const withFields = (fields) => Object.assign(new Error('refresh failed'), fields);

	for (const [name, error] of [
		['an HTTP client 401', withFields({ response: { status: 401, headers: {}, data: {} } })],
		['a wrapped 401', withFields({ cause: { response: { status: 401, headers: {}, data: {} } } })],
		[
			'a refused refresh with status and body',
			withFields({ status: 400, body: { error: 'invalid_grant' } }),
		],
		['a refresh AuthError', withFields({ code: 'EAUTH', body: { error: 'invalid_grant' } })],
	]) {
		it(`tells the user to reconnect for ${name}`, async () => {
			await assert.rejects(wordsmithApi.call(failing(error), 'GET', '/me'), (thrown) => {
				assert.equal(thrown.description, reconnect.description);
				return true;
			});
		});
	}

	it('keeps the API’s own message for a 400 on OAuth2', async () => {
		const ctx = apiContext({
			authentication: 'oAuth2',
			respond: () => ({
				statusCode: 400,
				headers: {},
				body: { error_code: 'invalid_request_body', message: 'Question is required.' },
			}),
		});
		await assert.rejects(wordsmithApi.call(ctx, 'GET', '/me'), (thrown) => {
			assert.equal(thrown.message, 'Question is required.');
			assert.notEqual(thrown.description, reconnect.description);
			return true;
		});
	});

	it('gives no reconnect guidance when the connection itself fails', async () => {
		const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
		await assert.rejects(wordsmithApi.call(failing(refused), 'GET', '/me'), (thrown) => {
			assert.notEqual(thrown.description, reconnect.description);
			return true;
		});
	});

	it('shows a transient token error as it is, not as a refused grant', async () => {
		const busy = withFields({
			code: 'EAUTH',
			body: { error: 'temporarily_unavailable', error_description: 'Try again shortly.' },
		});
		await assert.rejects(wordsmithApi.call(failing(busy), 'GET', '/me'), (thrown) => {
			assert.equal(thrown.httpCode, '400');
			assert.equal(thrown.message, 'Try again shortly.');
			assert.notEqual(thrown.description, reconnect.description);
			return true;
		});
	});

	it('passes n8n’s own reconnect error through unchanged', async () => {
		const { NodeOperationError } = require('n8n-workflow');
		const own = new NodeOperationError(
			{ name: 'Wordsmith' },
			'The credential needs to be reconnected.',
		);
		await assert.rejects(wordsmithApi.call(failing(own), 'GET', '/me'), (thrown) => thrown === own);
	});

	it('gives an OAuth2 401 different guidance from an API key 401', () => {
		const refused = { statusCode: 401, headers: {}, body: {} };
		assert.notEqual(
			errorMessage(refused, 'wordsmithOAuth2Api').description,
			errorMessage(refused, 'wordsmithApi').description,
		);
	});
});

describe('Callback URL on an API key connection', () => {
	it('is sent, trimmed', async () => {
		const ctx = apiContext({
			authentication: 'apiKey',
			parameters: {
				blueprint: { mode: 'id', value: '' },
				instructions: 'A short NDA',
				draftOptions: {},
				waitForResult: false,
				callbackUrl: '  https://n8n.example.com/webhook-waiting/1  ',
			},
			respond: () => ({ statusCode: 202, headers: {}, body: { id: 'op1', status: 'queued' } }),
		});
		await OPERATIONS.draft_document.call(ctx, 0, 'draft_document');
		assert.equal(ctx.calls[0].credential, 'wordsmithApi');
		assert.equal(
			ctx.calls[0].options.body.callback_url,
			'https://n8n.example.com/webhook-waiting/1',
		);
	});
});
