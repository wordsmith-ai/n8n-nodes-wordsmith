import { createHmac, timingSafeEqual } from 'crypto';

/** Parses `Wordsmith-Signature: t=…,v1=…[,v1=…]` and checks it against the raw body. */
export function verifySignature(
	rawBody: string,
	header: unknown,
	secret: string,
	nowSeconds: number,
	toleranceSeconds = 60,
): boolean {
	if (typeof header !== 'string' || header === '' || secret === '') return false;
	let timestamp: number | undefined;
	const signatures: string[] = [];
	for (const part of header.split(',')) {
		const index = part.indexOf('=');
		if (index < 0) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (key === 't') timestamp = Number(value);
		if (key === 'v1') signatures.push(value);
	}
	if (timestamp === undefined || !Number.isFinite(timestamp) || signatures.length === 0) {
		return false;
	}
	if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
	const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
	return signatures.some((signature) => {
		const given = Buffer.from(signature, 'hex');
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}
