// Credential expressions for the Wordsmith hosts. A host set by hand must be https on wordsmith.ai; anything else
// resolves to a host that fails, so the API key, client secret and tokens never go elsewhere.
/**
 * The one rule for a host set by hand: https, a host on wordsmith.ai with an optional port, and any path, which is
 * dropped. Group 1 is the host and group 2 a port other than 443, which is dropped too, because OAuth checks the
 * resource URL exactly. customHost uses it for requests, and the credential expressions embed its source.
 */
export const WORDSMITH_HOST =
	/^https:\/\/((?:[a-z0-9-]+\.)*wordsmith\.ai)(?::443|(:\d+))?(?:[/?#].*)?$/i;
const ON_WORDSMITH = WORDSMITH_HOST.toString();

type Root = '$self' | '$credentials';

function checked(root: Root, field: string, invalid: string): string {
	const match = `String(${root}["${field}"]).trim().match(${ON_WORDSMITH})`;
	return `(${match} ? "https://" + ${match}[1].toLowerCase() + (${match}[2] ?? "") : "https://${invalid}.wordsmith.ai")`;
}

const customHostOn = (root: Root) => `${root}["useCustomHost"] === true`;

/** API Host when Use a Custom Host is on; else a 0.2.0 credential's region or custom Base URL; else the EU host, which reaches every region. */
export function apiHostExpression(root: Root): string {
	return `(${customHostOn(root)} ? ${checked(root, 'apiHost', 'invalid-api-host')} : ${root}["region"] === "us" ? "https://api.us.wordsmith.ai" : ${root}["region"] === "custom" ? ${checked(root, 'baseUrl', 'invalid-base-url')} : "https://api.wordsmith.ai")`;
}

/** App Host when Use a Custom Host is on; else a 0.2.0 custom App URL; else the web app, where every region signs in. */
export function appHostExpression(root: Root): string {
	return `(${customHostOn(root)} ? ${checked(root, 'appHost', 'invalid-app-host')} : ${root}["region"] === "custom" ? ${checked(root, 'appUrl', 'invalid-app-url')} : "https://app.wordsmith.ai")`;
}
