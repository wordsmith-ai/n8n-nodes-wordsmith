import type { IDataObject } from 'n8n-workflow';

import { retryAfterSeconds } from './transport';

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const LONG_POLL_SECONDS = 20;
const QUESTION_POLL_SECONDS = 5;

export interface Clock {
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

export type WaitResult = { done: true; value: IDataObject } | { done: false; value: IDataObject };

/**
 * Long-polls `GET /operations/{id}?wait=…` until the operation ends or `maxWaitSeconds` pass. When a poll
 * answers early with the operation still running, it sleeps `poll_after_seconds` first: past a customer's
 * concurrent long-polls the API answers at once, and a loop without the sleep would spin.
 */
export async function waitForOperation(
	operation: IDataObject,
	maxWaitSeconds: number,
	getOperation: (operationId: string, waitSeconds: number) => Promise<IDataObject>,
	clock: Clock,
): Promise<WaitResult> {
	const deadline = clock.now() + maxWaitSeconds * 1000;
	let current = operation;
	while (!TERMINAL_STATUSES.has(String(current.status))) {
		const remainingMs = deadline - clock.now();
		if (remainingMs <= 0) return { done: false, value: current };
		const waitSeconds = Math.max(1, Math.min(LONG_POLL_SECONDS, Math.floor(remainingMs / 1000)));
		const startedAt = clock.now();
		current = await getOperation(String(current.id), waitSeconds);
		if (TERMINAL_STATUSES.has(String(current.status))) break;
		const answeredEarly = clock.now() - startedAt < (waitSeconds - 1) * 1000;
		if (answeredEarly) {
			const pauseMs = Math.min(
				retryAfterSeconds(current.poll_after_seconds) * 1000,
				deadline - clock.now(),
			);
			if (pauseMs > 0) await clock.sleep(pauseMs);
		}
	}
	return { done: true, value: current };
}

/** For a question with no operation: reads it every few seconds until it leaves `in_progress`. */
export async function waitForQuestion(
	question: IDataObject,
	maxWaitSeconds: number,
	getQuestion: () => Promise<IDataObject>,
	clock: Clock,
): Promise<WaitResult> {
	const deadline = clock.now() + maxWaitSeconds * 1000;
	let current = question;
	while (current.status === 'in_progress') {
		const pauseMs = Math.min(QUESTION_POLL_SECONDS * 1000, deadline - clock.now());
		if (pauseMs <= 0) return { done: false, value: current };
		await clock.sleep(pauseMs);
		current = await getQuestion();
	}
	return { done: true, value: current };
}

/**
 * Idempotency-Key for a start call: stable across n8n's retries of one run of a node, and new for each item and
 * each run, such as each pass through a loop.
 */
export function idempotencyKey(
	executionId: string,
	nodeName: string,
	runIndex: number,
	itemIndex: number,
): string {
	return `n8n:${executionId}:${nodeName}:${runIndex}:${itemIndex}`.slice(0, 255);
}
