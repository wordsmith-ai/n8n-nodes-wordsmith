import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { WordsmithOAuth2Api } = require('../dist/credentials/WordsmithOAuth2Api.credentials.js');
const { credentialName } = require('../dist/nodes/shared/transport.js');
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

describe('Wordsmith OAuth2 credential', () => {
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

	it('asks for the webhook scopes the trigger needs', () => {
		const scope = new WordsmithOAuth2Api().properties
			.find((p) => p.name === 'scope')
			.default.split(' ');
		for (const needed of [
			'webhooks:read',
			'webhooks:write',
			'sessions:write',
			'reviews:write',
			'tasks:write',
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

	it('keeps Wordsmith Trigger on API keys, because automatic OAuth2 clients get no webhook scopes', () => {
		const { properties, credentials, version } = new WordsmithTrigger().description;
		assert.deepEqual(version, [1, 2]);
		const fields = properties.filter((p) => p.name === 'authentication');
		assert.deepEqual(
			fields.map((p) => [p.displayOptions.show['@version'][0], p.default]),
			[
				[1, 'apiKey'],
				[2, 'apiKey'],
			],
		);
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
