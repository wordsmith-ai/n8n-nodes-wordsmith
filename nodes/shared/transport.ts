import type {
	IDataObject,
	IExecuteFunctions,
	INodeCredentialDescription,
	INodeProperties,
	INodePropertyOptions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import { WORDSMITH_HOST } from './hosts';

export type WordsmithContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions
	| IPollFunctions;

export const WORDSMITH_API_CREDENTIAL = 'wordsmithApi';
export const SIGN_IN_CREDENTIAL = 'wordsmithOAuth2Api';
const oAuth2Option = {
	name: 'OAuth2 (Recommended)',
	value: 'oAuth2',
	description: 'Sign in to Wordsmith and approve what n8n may do',
};
const apiKeyOption = {
	name: 'API Key',
	value: 'apiKey',
	description: 'A key from Wordsmith Settings → API keys',
};

function authenticationField(
	version: number,
	defaultValue: string,
	options: INodePropertyOptions[],
): INodeProperties {
	return {
		displayName: 'Authentication',
		name: 'authentication',
		type: 'options',
		noDataExpression: true,
		options,
		default: defaultValue,
		displayOptions: { show: { '@version': [version] } },
	};
}

/** The Authentication field every Wordsmith node shows. Version 2, the default, recommends OAuth2. */
export const authenticationProperties: INodeProperties[] = [
	authenticationField(1, 'apiKey', [oAuth2Option, apiKeyOption]),
	authenticationField(2, 'oAuth2', [oAuth2Option, apiKeyOption]),
];

/**
 * Wordsmith Trigger's Authentication field. Versions 1 and 2 shipped defaulting to the API key, and a saved node
 * omits a field left at its default, so they keep it. Version 3 defaults to OAuth2, now that the scopes the API
 * lists for `/api/v1`, which a self-registered client receives, include the webhook scopes.
 */
export const triggerAuthenticationProperties: INodeProperties[] = [
	...[1, 2].map((version) => authenticationField(version, 'apiKey', [apiKeyOption, oAuth2Option])),
	authenticationField(3, 'oAuth2', [oAuth2Option, apiKeyOption]),
];

/** Wordsmith Trigger's versions: 3 moves the default to OAuth2 without changing saved version-2 nodes. */
export const TRIGGER_VERSIONS = { version: [1, 2, 3], defaultVersion: 3 };

/**
 * Version 1 is kept so n8n recognises a Wordsmith node saved with the package's 0.1.0, the only release that
 * published version 1, and the action node can stop it. Version 2 is the default and defaults to OAuth2.
 */
export const NODE_VERSIONS = { version: [1, 2], defaultVersion: 2 };

export const credentialsFor = (): INodeCredentialDescription[] => [
	{
		name: SIGN_IN_CREDENTIAL,
		required: true,
		displayOptions: { show: { authentication: ['oAuth2'] } },
	},
	{
		name: WORDSMITH_API_CREDENTIAL,
		required: true,
		displayOptions: { show: { authentication: ['apiKey'] } },
	},
];

/**
 * The credential the node's Authentication field picks. It reads the field through `getNodeParameter`, which
 * fills in the node version's default, because a saved workflow omits fields left at their default. The API key
 * is the fallback, as version 1's default.
 */
export function credentialName(this: WordsmithContext): string {
	const authentication =
		'getInputData' in this
			? (this as IExecuteFunctions).getNodeParameter('authentication', 0, 'apiKey')
			: (this as Exclude<WordsmithContext, IExecuteFunctions>).getNodeParameter(
					'authentication',
					'apiKey',
				);
	return authentication === 'apiKey' ? WORDSMITH_API_CREDENTIAL : SIGN_IN_CREDENTIAL;
}

/** Keep in step with package.json; a test checks it. */
export const PACKAGE_VERSION = '0.3.1';
export const INTEGRATION_HEADER = { 'Wordsmith-Integration': `n8n/${PACKAGE_VERSION}` };

const REGION_HOSTS: Record<string, string> = {
	eu: 'https://api.wordsmith.ai',
	us: 'https://api.us.wordsmith.ai',
};

/**
 * A custom host as `https://<host>`, or undefined unless it is https on wordsmith.ai. The check keeps a typo or
 * a pasted link from sending the API key to another host.
 */
export function customHost(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const match = value.trim().match(WORDSMITH_HOST);
	return match ? `https://${match[1].toLowerCase()}${match[2] ?? ''}` : undefined;
}

/**
 * The `/api/v1` root: the credential's API Host when Use a Custom Host is on, else a 0.2.0 credential's region or custom Base URL, else the
 * EU host, which forwards a request for a customer held in another region to that region.
 */
export function apiBaseUrl(credentials: IDataObject): string {
	if (credentials.useCustomHost === true) {
		const host = customHost(credentials.apiHost);
		if (!host) {
			throw new Error(
				'Set the API Host in the Wordsmith credential to an https address on wordsmith.ai, such as https://api.us.wordsmith.ai, or turn off Use a Custom Host.',
			);
		}
		return `${host}/api/v1`;
	}
	const region = (credentials.region as string | undefined) ?? 'eu';
	const host = region === 'custom' ? customHost(credentials.baseUrl) : REGION_HOSTS[region];
	if (!host) {
		// The 0.2.0 field is hidden, so the user can only override it.
		throw new Error(
			'This Wordsmith credential holds a host saved by an earlier version of the node, and it is not an https address on wordsmith.ai. Turn on Use a Custom Host in the credential and set the API Host, and on an OAuth2 credential the App Host, to replace it. The pre-filled hosts work for every Wordsmith organisation.',
		);
	}
	return `${host}/api/v1`;
}

export interface RawResponse {
	statusCode: number;
	headers: Record<string, unknown>;
	body: unknown;
}

const RETRYABLE_CONFLICTS = new Set(['scan_in_progress', 'upload_completion_in_progress']);
const RETRY_BUDGET_MS = 60_000;

/** Whether a response is one the design lets a connector retry: 429, 503 and two 409s. */
export function isRetryable(response: RawResponse): boolean {
	if (response.statusCode === 429 || response.statusCode === 503) return true;
	const code = (response.body as IDataObject | undefined)?.error_code;
	return response.statusCode === 409 && RETRYABLE_CONFLICTS.has(String(code));
}

/** Seconds from a Retry-After header, kept between 1 and `max`, or `fallback`. */
export function retryAfterSeconds(value: unknown, fallback = 5, max = 60): number {
	const seconds = Number(Array.isArray(value) ? value[0] : value);
	if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
	return Math.min(Math.max(Math.ceil(seconds), 1), max);
}

/** The text a failed step shows: the API's message, or what to do about a refused key. */
export function errorMessage(
	response: RawResponse,
	credential = WORDSMITH_API_CREDENTIAL,
): { message: string; description?: string } {
	const body = (response.body ?? {}) as IDataObject;
	const code = typeof body.error_code === 'string' ? body.error_code : undefined;
	const apiMessage = typeof body.message === 'string' ? body.message : undefined;
	const refused =
		response.statusCode === 401 || (response.statusCode === 400 && body.error === 'invalid_grant');
	if (refused && credential === SIGN_IN_CREDENTIAL) {
		// After n8n's own refresh has failed: the grant was revoked, expired or disconnected.
		return {
			message: 'Wordsmith refused the OAuth2 connection',
			description:
				'Open the Wordsmith OAuth2 API credential and select Connect my account to sign in again.',
		};
	}
	if (response.statusCode === 401) {
		return {
			message: 'Wordsmith refused the API key',
			description:
				'Reconnect the Wordsmith credential with a valid API key, created in Wordsmith under Settings → API Keys.',
		};
	}
	// An OAuth token error carries `error` and `error_description` instead of the API's `message`.
	const oauthMessage =
		typeof body.error_description === 'string'
			? body.error_description
			: typeof body.error === 'string'
				? body.error
				: undefined;
	const message =
		apiMessage ?? oauthMessage ?? `Wordsmith answered with status ${response.statusCode}`;
	// Over OAuth a missing scope is RFC 6750's `{error: 'insufficient_scope'}`, not the API's `error_code`.
	const oauthCode = typeof body.error === 'string' ? body.error : undefined;
	if (
		credential === SIGN_IN_CREDENTIAL &&
		(code ?? oauthCode) === 'insufficient_scope' &&
		response.statusCode === 403
	) {
		return {
			message,
			description:
				'Open the Wordsmith OAuth2 API credential and select Connect my account to approve the missing scope.',
		};
	}
	const shownCode = code ?? (oauthMessage !== undefined ? oauthCode : undefined);
	return { message, description: shownCode ? `Error code: ${shownCode}` : undefined };
}

export function toNodeApiError(
	this: WordsmithContext,
	response: RawResponse,
	itemIndex?: number,
	credential?: string,
): NodeApiError {
	const { message, description } = errorMessage(response, credential);
	return new NodeApiError(
		this.getNode(),
		{ ...((response.body ?? {}) as JsonObject), httpCode: String(response.statusCode) },
		{ message, description, httpCode: String(response.statusCode), itemIndex },
	);
}

export interface RequestOptions {
	body?: IDataObject;
	qs?: IDataObject;
	headers?: Record<string, string>;
	/** Return non-2xx responses instead of throwing. */
	allowStatus?: number[];
}

/**
 * Calls the Wordsmith API with the credential. Retries 429, 503 and the retryable 409s for up to a minute,
 * after Retry-After. Throws a NodeApiError with the API's message on any other non-2xx status.
 */
export async function wordsmithRequest(
	this: WordsmithContext,
	method: IHttpRequestMethods,
	pathOrUrl: string,
	options: RequestOptions = {},
): Promise<RawResponse> {
	const credential = credentialName.call(this);
	const credentials = await this.getCredentials(credential);
	const base = apiBaseUrl(credentials);
	const request: IHttpRequestOptions = {
		method,
		url: pathOrUrl.startsWith('http') ? pathOrUrl : `${base}${pathOrUrl}`,
		json: true,
		headers: { Accept: 'application/json', ...INTEGRATION_HEADER, ...options.headers },
		returnFullResponse: true,
		// n8n refreshes an OAuth2 token only when the request throws a 401, so a 401 must not be ignored there.
		ignoreHttpStatusErrors:
			credential === SIGN_IN_CREDENTIAL ? { ignore: true, except: [401] } : true,
	};
	if (options.body !== undefined) request.body = options.body;
	if (options.qs !== undefined) request.qs = options.qs;

	const startedAt = Date.now();
	for (;;) {
		let response: RawResponse;
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				credential,
				request,
			)) as RawResponse;
		} catch (error) {
			// n8n's own "reconnect the credential" error, from a refused refresh, is already the right message.
			if (error instanceof NodeOperationError) throw new NodeOperationError(this.getNode(), error);
			// An HTTP or OAuth token error the request helper can read as a response; anything else is unexpected.
			const failed = responseOfError(error);
			if (!failed) throw new NodeApiError(this.getNode(), error as JsonObject);
			response = failed;
		}
		if (response.statusCode >= 200 && response.statusCode < 300) return response;
		if (options.allowStatus?.includes(response.statusCode)) return response;
		const waitMs = retryAfterSeconds(response.headers['retry-after'], 3) * 1000;
		if (!isRetryable(response) || Date.now() - startedAt + waitMs > RETRY_BUDGET_MS) {
			throw toNodeApiError.call(this, response, undefined, credential);
		}
		await sleep(waitMs);
	}
}

interface HttpErrorShape {
	response?: { status?: unknown; headers?: unknown; data?: unknown };
	cause?: { response?: { status?: unknown; headers?: unknown; data?: unknown } };
	status?: unknown;
	body?: unknown;
	code?: unknown;
}

/**
 * The HTTP response a request error carries, if it carries one: an HTTP client error (`response`, or wrapped in
 * `cause.response`), or a token refresh failure from n8n's OAuth2 client, which carries `status` and `body`, or
 * only `code: 'EAUTH'` and the OAuth error `body`. An EAUTH error counts as a 401 only for `invalid_grant`.
 */
export function responseOfError(error: unknown): RawResponse | undefined {
	const shape = (error ?? {}) as HttpErrorShape;
	const response = shape.response ?? shape.cause?.response;
	if (typeof response?.status === 'number') {
		return {
			statusCode: response.status,
			headers: (response.headers ?? {}) as Record<string, unknown>,
			body: response.data,
		};
	}
	if (typeof shape.status === 'number') {
		return { statusCode: shape.status, headers: {}, body: shape.body };
	}
	if (shape.code === 'EAUTH') {
		// The OAuth2 client raises EAUTH for any token error body. Only a refused grant means reconnecting.
		const refusedGrant = (shape.body as IDataObject | undefined)?.error === 'invalid_grant';
		return { statusCode: refusedGrant ? 401 : 400, headers: {}, body: shape.body };
	}
	return undefined;
}

/** wordsmithRequest that returns only the parsed body. */
export async function wordsmithApi(
	this: WordsmithContext,
	method: IHttpRequestMethods,
	path: string,
	options: RequestOptions = {},
): Promise<IDataObject> {
	return (await wordsmithRequest.call(this, method, path, options)).body as IDataObject;
}

/** Reads every page of a `{items, cursor}` list, up to `limit` items, or to the end when it is Infinity. */
export async function wordsmithList(
	this: WordsmithContext,
	path: string,
	qs: IDataObject,
	limit: number,
): Promise<IDataObject[]> {
	const items: IDataObject[] = [];
	let cursor: string | undefined;
	do {
		const page = (
			await wordsmithRequest.call(this, 'GET', path, {
				qs: { ...qs, limit: Math.min(100, limit - items.length), ...(cursor ? { cursor } : {}) },
			})
		).body as { items: IDataObject[]; cursor: string | null };
		items.push(...page.items);
		cursor = page.cursor ?? undefined;
	} while (cursor && items.length < limit);
	return items.slice(0, limit);
}

/** Path segment encoding for an id. */
export const id = (value: unknown): string => encodeURIComponent(String(value).trim());

/**
 * A task id or number as a path segment. A `#` cannot travel in a path (it starts the fragment, and encoded
 * it reaches the API as `%23`), so `#12` is sent as the number the API also accepts.
 */
export const taskRef = (value: unknown): string => id(String(value).trim().replace(/^#/, ''));

/** Splits a comma-separated field into trimmed, non-empty values. */
export function splitList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value !== 'string') return [];
	return value
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}
