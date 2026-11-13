import type {
	IBinaryKeyData,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';

import { collectFileIds, downloadFile, resolveFileInput, uploadBinary } from '../shared/files';
import {
	WORDSMITH_API_CREDENTIAL,
	credentialName,
	id,
	splitList,
	taskRef,
	wordsmithApi,
	wordsmithList,
	wordsmithRequest,
} from '../shared/transport';
import { idempotencyKey, waitForOperation, waitForQuestion } from '../shared/waiting';

type Result = INodeExecutionData[];

const clock = { sleep, now: Date.now };
const MAX_QUESTION_FILES = 10;

function item(
	this: IExecuteFunctions,
	itemIndex: number,
	json: IDataObject,
	binary?: IBinaryKeyData,
) {
	const result: INodeExecutionData = { json, pairedItem: { item: itemIndex } };
	if (binary && Object.keys(binary).length > 0) result.binary = binary;
	return result;
}

function locatorValue(this: IExecuteFunctions, name: string, itemIndex: number): string {
	const value = this.getNodeParameter(name, itemIndex, '', { extractValue: true });
	return typeof value === 'string' ? value.trim() : '';
}

/** The node's run in this execution: it grows in a loop and stays the same across Retry On Fail. */
export function runIndex(this: IExecuteFunctions, itemIndex: number): number {
	return this.getWorkflowDataProxy(itemIndex).$runIndex;
}

function startHeaders(this: IExecuteFunctions, itemIndex: number): Record<string, string> {
	return {
		'Idempotency-Key': idempotencyKey(
			this.getExecutionId(),
			this.getNode().name,
			runIndex.call(this, itemIndex),
			itemIndex,
		),
	};
}

interface WaitSettings {
	wait: boolean;
	maxWaitSeconds: number;
	callbackUrl?: string;
}

function waitSettings(this: IExecuteFunctions, itemIndex: number): WaitSettings {
	const wait = this.getNodeParameter('waitForResult', itemIndex, true) as boolean;
	if (wait) {
		const minutes = this.getNodeParameter('maxWaitMinutes', itemIndex, 15) as number;
		return { wait, maxWaitSeconds: minutes * 60 };
	}
	// Callbacks are signed with an API key's webhook secret, so an OAuth connection sends none.
	if (credentialName.call(this) !== WORDSMITH_API_CREDENTIAL) return { wait, maxWaitSeconds: 0 };
	const callbackUrl = (this.getNodeParameter('callbackUrl', itemIndex, '') as string).trim();
	return { wait, maxWaitSeconds: 0, callbackUrl: callbackUrl || undefined };
}

/**
 * Sets fields on an error that Continue On Fail puts in its output item, such as the job id to read later.
 */
export function withContext<T extends NodeOperationError>(error: T, context: IDataObject): T {
	error.context = { ...error.context, ...context };
	return error;
}

/** Waits for an operation and fails the step unless it succeeded. */
async function finishOperation(
	this: IExecuteFunctions,
	itemIndex: number,
	operation: IDataObject,
	maxWaitSeconds: number,
): Promise<IDataObject> {
	const outcome = await waitForOperation(
		operation,
		maxWaitSeconds,
		async (operationId, waitSeconds) =>
			await wordsmithApi.call(this, 'GET', `/operations/${id(operationId)}`, {
				qs: { wait: waitSeconds },
			}),
		clock,
	);
	const finished = outcome.value;
	if (!outcome.done) {
		throw withContext(
			new NodeOperationError(
				this.getNode(),
				`Wordsmith is still working after ${Math.round(maxWaitSeconds / 60)} minutes`,
				{
					itemIndex,
					description: `Read the result later with Get a Job and job ID ${String(finished.id)}, or raise Maximum Wait.`,
				},
			),
			{ operation_id: finished.id, status: finished.status },
		);
	}
	if (finished.status === 'succeeded') return finished;
	const error = (finished.error ?? {}) as IDataObject;
	throw withContext(
		new NodeOperationError(
			this.getNode(),
			finished.status === 'cancelled'
				? 'The Wordsmith job was cancelled'
				: String(error.message ?? 'The Wordsmith job failed'),
			{
				itemIndex,
				description: `Job ${String(finished.id)}${error.code ? `, error code ${String(error.code)}` : ''}.`,
			},
		),
		{ operation_id: finished.id, status: finished.status, error_code: error.code ?? null },
	);
}

/** Downloads each file id into the item's binary fields: `field`, then `field_1`, `field_2`… */
async function filesOutput(
	this: IExecuteFunctions,
	fileIds: string[],
	field: string,
): Promise<{ json: IDataObject; binary: IBinaryKeyData }> {
	const binary: IBinaryKeyData = {};
	const files: IDataObject[] = [];
	for (const [index, fileId] of fileIds.entries()) {
		const downloaded = await downloadFile.call(this, fileId);
		binary[index === 0 ? field : `${field}_${index}`] = downloaded.binary;
		files.push(downloaded.json);
	}
	const first = files[0] ?? {};
	return { json: { ...first, ...(files.length > 1 ? { files } : {}) }, binary };
}

async function startJob(
	this: IExecuteFunctions,
	itemIndex: number,
	path: string,
	body: IDataObject,
): Promise<{ operation: IDataObject; settings: WaitSettings }> {
	const settings = waitSettings.call(this, itemIndex);
	if (settings.callbackUrl) body.callback_url = settings.callbackUrl;
	const operation = await wordsmithApi.call(this, 'POST', path, {
		body,
		headers: startHeaders.call(this, itemIndex),
	});
	return { operation, settings };
}

// ── Agents ──────────────────────────────────────────────────────────────────────────

async function questionWithFiles(
	this: IExecuteFunctions,
	itemIndex: number,
	question: IDataObject,
): Promise<INodeExecutionData> {
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const attachments = (question.attachments as IDataObject[] | null) ?? [];
	if (!options.downloadAnswerFiles || attachments.length === 0) {
		return item.call(this, itemIndex, question);
	}
	const binary: IBinaryKeyData = {};
	for (const [index, attachment] of attachments.entries()) {
		const data = (await this.helpers.httpRequest({
			method: 'GET',
			url: attachment.url as string,
			encoding: 'arraybuffer',
			json: false,
		})) as ArrayBuffer;
		binary[`file_${index}`] = await this.helpers.prepareBinaryData(
			Buffer.from(data),
			(attachment.file_name as string | null) ?? `file_${index}`,
			(attachment.content_type as string | null) ?? undefined,
		);
	}
	return item.call(this, itemIndex, question, binary);
}

async function askAgent(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const agentId = locatorValue.call(this, 'agent', itemIndex) || 'default';
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const binaryNames = splitList(options.binaryFields);
	const givenIds = splitList(options.fileIds);
	if (binaryNames.length + givenIds.length > MAX_QUESTION_FILES) {
		throw new NodeOperationError(this.getNode(), 'Too many files for one question', {
			itemIndex,
			description: `A question takes up to ${MAX_QUESTION_FILES} files.`,
		});
	}
	const fileIds = await collectFileIds.call(this, itemIndex, options.binaryFields, options.fileIds);

	const body: IDataObject = { question: this.getNodeParameter('question', itemIndex) as string };
	if (fileIds.length > 0) body.attachments = fileIds.map((fileId) => ({ file_id: fileId }));
	if (options.sessionId) body.session_id = String(options.sessionId).trim();
	if (options.visibility) body.permissions = { visibility: options.visibility };

	const settings = waitSettings.call(this, itemIndex);
	if (settings.callbackUrl) body.callback_url = settings.callbackUrl;
	const questionPath = `/agents/${id(agentId)}/questions`;
	const started = await wordsmithApi.call(this, 'POST', questionPath, {
		body,
		headers: startHeaders.call(this, itemIndex),
	});
	if (!settings.wait) return [await questionWithFiles.call(this, itemIndex, started)];

	const readQuestion = async () =>
		await wordsmithApi.call(this, 'GET', `${questionPath}/${id(started.id)}`);
	// The operation is the designed way to wait. A question asked before operations existed has none.
	const outcome =
		started.status !== 'in_progress'
			? { done: true, value: started }
			: started.operation_id
				? await waitForOperation(
						{ id: started.operation_id, status: 'running' },
						settings.maxWaitSeconds,
						async (operationId, waitSeconds) =>
							await wordsmithApi.call(this, 'GET', `/operations/${id(operationId)}`, {
								qs: { wait: waitSeconds },
							}),
						clock,
					)
				: await waitForQuestion(started, settings.maxWaitSeconds, readQuestion, clock);
	if (!outcome.done) {
		throw withContext(
			new NodeOperationError(this.getNode(), 'The agent is still working', {
				itemIndex,
				description: `Read the answer later with Get an Answer and question ID ${String(started.id)}, or raise Maximum Wait.`,
			}),
			{ question_id: started.id, operation_id: started.operation_id ?? null },
		);
	}
	// Whatever the operation's outcome, the question holds the answer, or the partial answer of a failure.
	// A question that was already over when started (such as an idempotent replay) is read as it is.
	const question =
		started.status !== 'in_progress'
			? started
			: started.operation_id
				? await readQuestion()
				: outcome.value;
	if (question.status === 'error' || question.status === 'in_progress') {
		throw withContext(
			new NodeOperationError(this.getNode(), 'The agent could not answer the question', {
				itemIndex,
				description: `Question ${String(question.id)} ended with status ${String(question.status)}. Any answer text may be partial: ${String(question.answer ?? 'none')}. Open ${String(question.session_url ?? 'the conversation')} to see what happened.`,
			}),
			{
				question_id: question.id,
				status: question.status,
				session_url: question.session_url ?? null,
			},
		);
	}
	return [await questionWithFiles.call(this, itemIndex, question)];
}

async function getQuestion(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const agentId = locatorValue.call(this, 'agent', itemIndex) || 'default';
	const questionId = this.getNodeParameter('questionId', itemIndex) as string;
	const question = await wordsmithApi.call(
		this,
		'GET',
		`/agents/${id(agentId)}/questions/${id(questionId)}`,
	);
	return [await questionWithFiles.call(this, itemIndex, question)];
}

// ── Files and documents ─────────────────────────────────────────────────────────────

async function uploadFile(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const field = this.getNodeParameter('binaryPropertyName', itemIndex) as string;
	const fileName = (this.getNodeParameter('fileName', itemIndex, '') as string).trim();
	return [
		item.call(
			this,
			itemIndex,
			await uploadBinary.call(this, itemIndex, field, fileName || undefined),
		),
	];
}

async function getFile(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const fileId = String(this.getNodeParameter('fileId', itemIndex)).trim();
	const field = this.getNodeParameter('outputBinaryField', itemIndex, 'data') as string;
	const metadata = await wordsmithApi.call(this, 'GET', `/files/${id(fileId)}`);
	const downloaded = await downloadFile.call(this, fileId);
	return [
		item.call(
			this,
			itemIndex,
			{ ...downloaded.json, content_length: metadata.content_length ?? null },
			{ [field]: downloaded.binary },
		),
	];
}

async function getFileText(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const fileId = String(this.getNodeParameter('fileId', itemIndex)).trim();
	const qs: IDataObject = { max_chars: this.getNodeParameter('maxChars', itemIndex, 20000) };
	const offset = this.getNodeParameter('offset', itemIndex, 0) as number;
	if (offset > 0) qs.offset = offset;
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'GET', `/files/${id(fileId)}/text`, { qs }),
		),
	];
}

async function importFileFromUrl(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const body: IDataObject = { url: String(this.getNodeParameter('url', itemIndex)).trim() };
	const fileName = (this.getNodeParameter('fileName', itemIndex, '') as string).trim();
	if (fileName) body.file_name = fileName;
	return [
		item.call(this, itemIndex, await wordsmithApi.call(this, 'POST', '/files/import', { body })),
	];
}

async function createDocument(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const body: IDataObject = {
		file_name: String(this.getNodeParameter('fileName', itemIndex)).trim(),
		content: this.getNodeParameter('content', itemIndex) as string,
		format: this.getNodeParameter('format', itemIndex, 'docx'),
	};
	return [item.call(this, itemIndex, await wordsmithApi.call(this, 'POST', '/files', { body }))];
}

async function documentAction(
	this: IExecuteFunctions,
	itemIndex: number,
	operation: string,
): Promise<Result> {
	let path: string;
	const body: IDataObject = {};
	if (operation === 'compare_documents') {
		path = '/files/compare';
		body.original_file_id = await resolveFileInput.call(this, itemIndex, 'original');
		body.revised_file_id = await resolveFileInput.call(this, itemIndex, 'revised');
		body.output_format = this.getNodeParameter('outputFormat', itemIndex, 'docx');
	} else if (operation === 'merge_pdfs') {
		path = '/files/merge';
		const documents = this.getNodeParameter('documents', itemIndex, {}) as IDataObject;
		body.file_ids = await collectFileIds.call(
			this,
			itemIndex,
			documents.binaryFields,
			documents.fileIds,
		);
		if ((body.file_ids as string[]).length < 2) {
			throw new NodeOperationError(this.getNode(), 'Merging needs at least two documents', {
				itemIndex,
				description: 'Under Documents, name binary fields or enter file IDs: from 2 to 20 in all.',
			});
		}
		const fileName = (this.getNodeParameter('fileName', itemIndex, '') as string).trim();
		if (fileName) body.file_name = fileName;
	} else {
		const fileId = await resolveFileInput.call(this, itemIndex, 'document');
		if (operation === 'redline_document') {
			path = `/files/${id(fileId)}/redline`;
			body.instructions = this.getNodeParameter('instructions', itemIndex);
			const options = this.getNodeParameter('redlineOptions', itemIndex, {}) as IDataObject;
			if (options.authorName) body.author_name = options.authorName;
			if (options.actingParty) body.acting_party = options.actingParty;
		} else if (operation === 'translate_document') {
			path = `/files/${id(fileId)}/translate`;
			body.target_language = String(this.getNodeParameter('targetLanguage', itemIndex)).trim();
		} else if (operation === 'redact_document') {
			path = `/files/${id(fileId)}/redact`;
			body.categories = this.getNodeParameter('categories', itemIndex, []) as string[];
			body.terms = splitList(this.getNodeParameter('terms', itemIndex, ''));
			if ((body.categories as string[]).length === 0 && (body.terms as string[]).length === 0) {
				throw new NodeOperationError(this.getNode(), 'Nothing to redact', {
					itemIndex,
					description: 'Choose What to Redact, enter Terms to Redact, or both.',
				});
			}
		} else if (operation === 'accept_all_changes') {
			path = `/files/${id(fileId)}/accept-changes`;
			body.remove_protection = this.getNodeParameter('removeProtection', itemIndex, false);
		} else {
			path = `/files/${id(fileId)}/convert`;
			body.target_format = this.getNodeParameter('targetFormat', itemIndex);
		}
	}
	const { operation: started, settings } = await startJob.call(this, itemIndex, path, body);
	if (!settings.wait) return [item.call(this, itemIndex, started)];
	const finished = await finishOperation.call(this, itemIndex, started, settings.maxWaitSeconds);
	const result = (finished.result ?? {}) as IDataObject;
	const field = this.getNodeParameter('outputBinaryField', itemIndex, 'data') as string;
	const output = await filesOutput.call(this, splitList(result.file_ids), field);
	return [
		item.call(
			this,
			itemIndex,
			{ ...output.json, summary: result.summary ?? null, operation_id: finished.id },
			output.binary,
		),
	];
}

// ── Reviews and drafts ──────────────────────────────────────────────────────────────

async function issuesOf(this: IExecuteFunctions, reviewId: string): Promise<IDataObject[]> {
	const findings = await wordsmithList.call(
		this,
		`/reviews/${id(reviewId)}/findings`,
		{ status: 'issue' },
		Number.POSITIVE_INFINITY,
	);
	return findings.map((finding) => ({
		name: finding.name,
		severity: finding.severity ?? null,
		explanation: finding.explanation ?? null,
		recommendation: finding.recommendation ?? null,
	}));
}

async function runReview(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const type = this.getNodeParameter('reviewType', itemIndex) as string;
	const documents = this.getNodeParameter('documents', itemIndex, {}) as IDataObject;
	const fileIds = await collectFileIds.call(
		this,
		itemIndex,
		documents.binaryFields,
		documents.fileIds,
	);
	if (fileIds.length === 0) {
		throw new NodeOperationError(this.getNode(), 'No documents to review', {
			itemIndex,
			description: 'Name a binary field or enter at least one file ID under Documents.',
		});
	}
	const body: IDataObject = { type, file_ids: fileIds };
	if (type === 'playbook') body.playbook_id = locatorValue.call(this, 'playbook', itemIndex);
	if (type === 'instructions') body.instructions = this.getNodeParameter('instructions', itemIndex);
	if (type === 'counterparty_edits') body.party = this.getNodeParameter('party', itemIndex);

	const { operation: started, settings } = await startJob.call(this, itemIndex, '/reviews', body);
	if (!settings.wait) return [item.call(this, itemIndex, started)];
	const finished = await finishOperation.call(this, itemIndex, started, settings.maxWaitSeconds);
	const result = (finished.result ?? {}) as IDataObject;
	const resource = (finished.resource ?? {}) as IDataObject;
	const reviewId = String(result.review_id ?? resource.id);
	const review = await wordsmithApi.call(this, 'GET', `/reviews/${id(reviewId)}`);
	const issues = await issuesOf.call(this, reviewId);
	const json: IDataObject = {
		id: review.id,
		name: review.name,
		type: review.type,
		status: review.status,
		url: review.url,
		findings: review.findings,
		redline_file_id: review.redline_file_id ?? null,
		issues,
		issues_text: issues
			.map((issue) =>
				`${String(issue.severity ?? 'issue')}: ${String(issue.name)}. ${String(issue.explanation ?? '')}`.trim(),
			)
			.join('\n'),
		operation_id: finished.id,
	};
	const downloadRedline = this.getNodeParameter('downloadRedline', itemIndex, true) as boolean;
	if (downloadRedline && review.redline_file_id) {
		const field = this.getNodeParameter('outputBinaryField', itemIndex, 'data') as string;
		const redline = await downloadFile.call(this, String(review.redline_file_id));
		json.redline_file = redline.json;
		return [item.call(this, itemIndex, json, { [field]: redline.binary })];
	}
	return [item.call(this, itemIndex, json)];
}

async function getReview(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const reviewId = (this.getNodeParameter('reviewId', itemIndex, '') as string).trim();
	if (reviewId) {
		return [
			item.call(this, itemIndex, await wordsmithApi.call(this, 'GET', `/reviews/${id(reviewId)}`)),
		];
	}
	const query = (this.getNodeParameter('query', itemIndex, '') as string).trim();
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll
		? Number.POSITIVE_INFINITY
		: (this.getNodeParameter('limit', itemIndex, 50) as number);
	const reviews = await wordsmithList.call(this, '/reviews', query ? { query } : {}, limit);
	return reviews.map((review) => item.call(this, itemIndex, review));
}

async function generateReviewRedline(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const reviewId = String(this.getNodeParameter('reviewId', itemIndex)).trim();
	const body: IDataObject = {};
	const findingIds = splitList(this.getNodeParameter('findingIds', itemIndex, ''));
	if (findingIds.length > 0) body.finding_ids = findingIds;
	const { operation: started, settings } = await startJob.call(
		this,
		itemIndex,
		`/reviews/${id(reviewId)}/redline`,
		body,
	);
	if (!settings.wait) return [item.call(this, itemIndex, started)];
	const finished = await finishOperation.call(this, itemIndex, started, settings.maxWaitSeconds);
	const result = (finished.result ?? {}) as IDataObject;
	const field = this.getNodeParameter('outputBinaryField', itemIndex, 'data') as string;
	const output = await filesOutput.call(this, splitList(result.file_id), field);
	return [
		item.call(
			this,
			itemIndex,
			{ ...output.json, review_id: reviewId, operation_id: finished.id },
			output.binary,
		),
	];
}

/** Blueprint values from the mapper. Array fields typed as text are parsed as JSON. */
function blueprintValues(this: IExecuteFunctions, itemIndex: number): IDataObject | undefined {
	const mapped = this.getNodeParameter('values', itemIndex, null) as ResourceMapperValue | null;
	if (!mapped?.value) return undefined;
	const types = new Map(mapped.schema.map((field) => [field.id, field.type]));
	const values: IDataObject = {};
	for (const [key, value] of Object.entries(mapped.value)) {
		if (value === null || value === '') continue;
		if (types.get(key) === 'array' && typeof value === 'string') {
			try {
				values[key] = JSON.parse(value) as IDataObject;
			} catch {
				values[key] = splitList(value);
			}
		} else {
			values[key] = value;
		}
	}
	return Object.keys(values).length > 0 ? values : undefined;
}

async function draftDocument(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const blueprintId = locatorValue.call(this, 'blueprint', itemIndex);
	const instructions = (this.getNodeParameter('instructions', itemIndex, '') as string).trim();
	if (!blueprintId && !instructions) {
		throw new NodeOperationError(this.getNode(), 'Nothing to draft from', {
			itemIndex,
			description: 'Choose a blueprint, or describe the document in Instructions.',
		});
	}
	const options = this.getNodeParameter('draftOptions', itemIndex, {}) as IDataObject;
	const body: IDataObject = { output_format: options.outputFormat ?? 'docx' };
	if (blueprintId) {
		body.blueprint_id = blueprintId;
		const values = blueprintValues.call(this, itemIndex);
		if (values) body.values = values;
	}
	if (options.fileName) body.file_name = options.fileName;
	if (instructions) body.instructions = instructions;
	if (options.context) body.context = options.context;
	const fileIds = await collectFileIds.call(this, itemIndex, options.binaryFields, options.fileIds);
	if (fileIds.length > 0) body.file_ids = fileIds;

	const { operation: started, settings } = await startJob.call(this, itemIndex, '/drafts', body);
	if (!settings.wait) return [item.call(this, itemIndex, started)];
	const finished = await finishOperation.call(this, itemIndex, started, settings.maxWaitSeconds);
	const result = (finished.result ?? {}) as IDataObject;
	const field = this.getNodeParameter('outputBinaryField', itemIndex, 'data') as string;
	const output = await filesOutput.call(this, splitList(result.file_id), field);
	return [
		item.call(
			this,
			itemIndex,
			{
				...output.json,
				url: result.url ?? null,
				values: result.values ?? null,
				operation_id: finished.id,
			},
			output.binary,
		),
	];
}

// ── Tasks and jobs ──────────────────────────────────────────────────────────────────

function taskFields(this: IExecuteFunctions, itemIndex: number, collection: string): IDataObject {
	const fields = this.getNodeParameter(collection, itemIndex, {}) as IDataObject;
	const body: IDataObject = {};
	for (const key of ['title', 'description', 'priority', 'status'] as const) {
		if (fields[key] !== undefined && fields[key] !== '') body[key] = fields[key];
	}
	if (fields.completeBy) body.complete_by = new Date(fields.completeBy as string).toISOString();
	if (fields.assignedTo !== undefined) {
		const assignee = locatorValue.call(this, `${collection}.assignedTo`, itemIndex);
		if (assignee) body.assigned_to = assignee;
	}
	if (fields.assignedAgent !== undefined) {
		const agent = locatorValue.call(this, `${collection}.assignedAgent`, itemIndex);
		if (agent) body.assigned_agent = agent;
	}
	return body;
}

const TASKS_KEPT = 500;
const startedTasks = new Map<string, { task: IDataObject; attached: boolean }>();

/** Tasks this process created for a step, by execution, node, run and item, so Retry On Fail reuses them. */
function taskStepKey(this: IExecuteFunctions, itemIndex: number): string {
	return [
		this.getExecutionId(),
		this.getNode().name,
		runIndex.call(this, itemIndex),
		itemIndex,
	].join(':');
}

function rememberTask(key: string, task: IDataObject, attached: boolean): void {
	startedTasks.set(key, { task, attached });
	if (startedTasks.size > TASKS_KEPT)
		startedTasks.delete(startedTasks.keys().next().value as string);
}

/**
 * With files, the task is created as a draft, the files are attached, then the draft is committed. An agent
 * never starts on a draft, so it starts on commit with its files in place, and the API checks the agent before
 * any task exists. `POST /tasks` takes no Idempotency-Key, so a retried step reuses the task it already made.
 */
async function createTask(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const body: IDataObject = {
		title: this.getNodeParameter('title', itemIndex) as string,
		...taskFields.call(this, itemIndex, 'additionalFields'),
	};
	const tags = splitList(fields.tags);
	if (tags.length > 0) body.tags = tags;
	if (fields.parentTaskId) body.parent_task_id = String(fields.parentTaskId).trim();
	const fileIds = await collectFileIds.call(this, itemIndex, fields.binaryFields, fields.fileIds);
	if (fileIds.length === 0) {
		return [item.call(this, itemIndex, await wordsmithApi.call(this, 'POST', '/tasks', { body }))];
	}

	const stepKey = taskStepKey.call(this, itemIndex);
	const earlier = startedTasks.get(stepKey);
	let task =
		earlier?.task ??
		(await wordsmithApi.call(this, 'POST', '/tasks', { body: { ...body, draft: true } }));
	const failed = (error: unknown, message: string, next: string) =>
		withContext(
			new NodeOperationError(this.getNode(), error as Error, {
				itemIndex,
				message: `Draft task ${String(task.display_id ?? task.id)} ${message}`,
				description: `${(error as Error).message}. ${next} The task is at ${String(task.url ?? 'its link in Wordsmith')}.`,
			}),
			{ task_id: task.id, task_url: task.url ?? null, draft: true },
		);
	if (!earlier?.attached) {
		rememberTask(stepKey, task, false);
		try {
			task = await wordsmithApi.call(this, 'POST', `/tasks/${id(task.id)}/files`, {
				body: { file_ids: fileIds },
			});
		} catch (error) {
			throw failed(
				error,
				'was created, but its files were not attached',
				'Retry the step to try again.',
			);
		}
		rememberTask(stepKey, task, true);
	}
	try {
		task = await wordsmithApi.call(this, 'PATCH', `/tasks/${id(task.id)}`, {
			body: { draft: false },
		});
	} catch (error) {
		throw failed(
			error,
			'has its files, but was not committed',
			'Retry the step, or accept the draft in Wordsmith.',
		);
	}
	startedTasks.delete(stepKey);
	return [item.call(this, itemIndex, task)];
}

async function updateTask(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const taskId = this.getNodeParameter('taskId', itemIndex) as string;
	const body = taskFields.call(this, itemIndex, 'updateFields');
	if (Object.keys(body).length === 0) {
		throw new NodeOperationError(this.getNode(), 'Nothing to update', {
			itemIndex,
			description: 'Add at least one field under Update Fields.',
		});
	}
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'PATCH', `/tasks/${taskRef(taskId)}`, { body }),
		),
	];
}

async function addTaskComment(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const taskId = this.getNodeParameter('taskId', itemIndex) as string;
	const files = this.getNodeParameter('files', itemIndex, {}) as IDataObject;
	const fileIds = await collectFileIds.call(this, itemIndex, files.binaryFields, files.fileIds);
	const body: IDataObject = { content: this.getNodeParameter('content', itemIndex) as string };
	if (fileIds.length > 0) body.file_ids = fileIds;
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'POST', `/tasks/${taskRef(taskId)}/comments`, { body }),
		),
	];
}

async function attachFilesToTask(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const taskId = this.getNodeParameter('taskId', itemIndex) as string;
	const files = this.getNodeParameter('files', itemIndex, {}) as IDataObject;
	const fileIds = await collectFileIds.call(this, itemIndex, files.binaryFields, files.fileIds);
	if (fileIds.length === 0) {
		throw new NodeOperationError(this.getNode(), 'No files to attach', {
			itemIndex,
			description: 'Under Files, name a binary field or enter at least one Wordsmith file ID.',
		});
	}
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'POST', `/tasks/${taskRef(taskId)}/files`, {
				body: { file_ids: fileIds },
			}),
		),
	];
}

async function replyToTaskRequester(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const taskId = this.getNodeParameter('taskId', itemIndex) as string;
	const files = this.getNodeParameter('files', itemIndex, {}) as IDataObject;
	const fileIds = await collectFileIds.call(this, itemIndex, files.binaryFields, files.fileIds);
	const body: IDataObject = { content: this.getNodeParameter('content', itemIndex) as string };
	if (fileIds.length > 0) body.file_ids = fileIds;
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'POST', `/tasks/${taskRef(taskId)}/thread`, { body }),
		),
	];
}

async function getTaskFiles(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const taskId = this.getNodeParameter('taskId', itemIndex) as string;
	const files = await wordsmithApi.call(this, 'GET', `/tasks/${taskRef(taskId)}/files`);
	if (!(this.getNodeParameter('downloadFiles', itemIndex, false) as boolean)) {
		return [item.call(this, itemIndex, files)];
	}
	const binary: IBinaryKeyData = {};
	const taskPath = `/tasks/${taskRef(String(files.task_id ?? taskId))}/files`;
	for (const [prefix, list] of [
		['input', files.input_files],
		['output', files.output_files],
	] as const) {
		for (const [index, file] of ((list as IDataObject[] | undefined) ?? []).entries()) {
			const fileId = String(file.id);
			const downloaded = await downloadFile.call(
				this,
				fileId,
				`${taskPath}/${id(fileId)}/download`,
			);
			binary[`${prefix}_${index}`] = downloaded.binary;
		}
	}
	return [item.call(this, itemIndex, files, binary)];
}

async function findTask(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const taskId = (this.getNodeParameter('taskId', itemIndex, '') as string).trim();
	if (taskId) {
		const response = await wordsmithRequest.call(this, 'GET', `/tasks/${taskRef(taskId)}`, {
			allowStatus: [404],
		});
		return response.statusCode === 404
			? []
			: [item.call(this, itemIndex, response.body as IDataObject)];
	}
	const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
	const qs: IDataObject = {};
	if (filters.query) qs.query = filters.query;
	if (filters.status) qs.status = filters.status;
	if (filters.assignedTo !== undefined) {
		const assignee = locatorValue.call(this, 'filters.assignedTo', itemIndex);
		if (assignee) qs.assigned_to = assignee;
	}
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll
		? Number.POSITIVE_INFINITY
		: (this.getNodeParameter('limit', itemIndex, 50) as number);
	const tasks = await wordsmithList.call(this, '/tasks', qs, limit);
	return tasks.map((task) => item.call(this, itemIndex, task));
}

async function getOperation(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const operationId = this.getNodeParameter('operationId', itemIndex) as string;
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'GET', `/operations/${id(operationId)}`),
		),
	];
}

// ── Agents, users and conversations ─────────────────────────────────────────────────

function nameMatches(value: unknown, needle: string): boolean {
	return typeof value === 'string' && value.toLowerCase().includes(needle);
}

async function findAgent(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const needle = String(this.getNodeParameter('name', itemIndex)).trim().toLowerCase();
	const agents = (await wordsmithApi.call(this, 'GET', '/agents')) as unknown as IDataObject[];
	return agents
		.filter((agent) => nameMatches(agent.name, needle))
		.map((agent) => item.call(this, itemIndex, agent));
}

/** An exact email match first; otherwise everyone whose name or email contains the search. */
async function findUser(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const needle = String(this.getNodeParameter('query', itemIndex)).trim().toLowerCase();
	const users = (await wordsmithApi.call(this, 'GET', '/users', {
		qs: { active_only: 'true' },
	})) as unknown as IDataObject[];
	const exact = users.filter((user) => String(user.email ?? '').toLowerCase() === needle);
	const matches =
		exact.length > 0
			? exact
			: users.filter((user) => nameMatches(user.name, needle) || nameMatches(user.email, needle));
	return matches.map((user) => item.call(this, itemIndex, user));
}

/** A `query` search over a paged list route, honouring Return All and Limit. */
async function findPaged(
	this: IExecuteFunctions,
	itemIndex: number,
	path: string,
): Promise<Result> {
	const query = String(this.getNodeParameter('query', itemIndex)).trim();
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll
		? Number.POSITIVE_INFINITY
		: (this.getNodeParameter('limit', itemIndex, 50) as number);
	const found = await wordsmithList.call(this, path, query ? { query } : {}, limit);
	return found.map((entry) => item.call(this, itemIndex, entry));
}

async function findConversation(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	return await findPaged.call(this, itemIndex, '/sessions');
}

async function getConversationMessages(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<Result> {
	const sessionId = String(this.getNodeParameter('sessionId', itemIndex)).trim();
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll
		? Number.POSITIVE_INFINITY
		: (this.getNodeParameter('limit', itemIndex, 50) as number);
	const messages = await wordsmithList.call(this, `/sessions/${id(sessionId)}/messages`, {}, limit);
	return messages.map((message) => item.call(this, itemIndex, message));
}

// ── Reports and repositories ────────────────────────────────────────────────────────

async function documentIds(this: IExecuteFunctions, itemIndex: number): Promise<string[]> {
	const documents = this.getNodeParameter('documents', itemIndex, {}) as IDataObject;
	return await collectFileIds.call(this, itemIndex, documents.binaryFields, documents.fileIds);
}

function noDocuments(this: IExecuteFunctions, itemIndex: number): NodeOperationError {
	return new NodeOperationError(this.getNode(), 'No documents to add', {
		itemIndex,
		description: 'Under Documents, name a binary field or enter at least one file ID.',
	});
}

async function createReport(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const columns = (
		(this.getNodeParameter('columns', itemIndex, {}) as IDataObject).column as
			| IDataObject[]
			| undefined
	)?.map((column) => {
		const spec: IDataObject = { name: column.name, prompt: column.prompt, type: column.type };
		const options = splitList(column.options);
		if (options.length > 0) spec.options = options;
		return spec;
	});
	const fileIds = await documentIds.call(this, itemIndex);
	const body: IDataObject = {
		name: this.getNodeParameter('name', itemIndex) as string,
		columns: columns ?? [],
		// The API refuses a run with no documents or no questions, and such a run would have nothing to fill in.
		run:
			(this.getNodeParameter('run', itemIndex, true) as boolean) &&
			fileIds.length > 0 &&
			(columns ?? []).length > 0,
	};
	if (fileIds.length > 0) body.file_ids = fileIds;
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'POST', '/reports', {
				body,
				headers: startHeaders.call(this, itemIndex),
			}),
		),
	];
}

async function addReportRows(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const reportId = locatorValue.call(this, 'report', itemIndex);
	const fileIds = await documentIds.call(this, itemIndex);
	if (fileIds.length === 0) throw noDocuments.call(this, itemIndex);
	const added = await wordsmithApi.call(this, 'POST', `/reports/${id(reportId)}/rows`, {
		body: { file_ids: fileIds },
	});
	const failed = splitList(added.failed_file_ids);
	if (failed.length > 0 && failed.length === fileIds.length) {
		throw withContext(
			new NodeOperationError(this.getNode(), 'Wordsmith could not add any of the documents', {
				itemIndex,
				description: `Retry the step. Files not added: ${failed.join(', ')}.`,
			}),
			{ report_id: reportId, failed_file_ids: failed },
		);
	}
	return [item.call(this, itemIndex, { report_id: reportId, ...added })];
}

async function runReport(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const reportId = locatorValue.call(this, 'report', itemIndex);
	const { operation: started, settings } = await startJob.call(
		this,
		itemIndex,
		`/reports/${id(reportId)}/runs`,
		{ only_empty: this.getNodeParameter('onlyEmpty', itemIndex, true) },
	);
	if (!settings.wait) return [item.call(this, itemIndex, started)];
	const finished = await finishOperation.call(this, itemIndex, started, settings.maxWaitSeconds);
	const result = (finished.result ?? {}) as IDataObject;
	return [
		item.call(this, itemIndex, {
			report_id: reportId,
			cells_completed: result.cells_completed ?? null,
			cells_total: result.cells_total ?? null,
			operation_id: finished.id,
		}),
	];
}

async function exportReport(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const reportId = locatorValue.call(this, 'report', itemIndex);
	const { operation: started, settings } = await startJob.call(
		this,
		itemIndex,
		`/reports/${id(reportId)}/exports`,
		{ format: this.getNodeParameter('format', itemIndex, 'xlsx') },
	);
	if (!settings.wait) return [item.call(this, itemIndex, started)];
	const finished = await finishOperation.call(this, itemIndex, started, settings.maxWaitSeconds);
	const result = (finished.result ?? {}) as IDataObject;
	const field = this.getNodeParameter('outputBinaryField', itemIndex, 'data') as string;
	const output = await filesOutput.call(this, splitList(result.file_id), field);
	return [
		item.call(
			this,
			itemIndex,
			{ ...output.json, report_id: reportId, operation_id: finished.id },
			output.binary,
		),
	];
}

/** Each column's key in the answers: its name, or `name (id)` when another column has the same name. */
export function answerKeys(columns: IDataObject[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const column of columns) {
		const name = String(column.name);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return new Map(
		columns.map((column) => {
			const name = String(column.name);
			const key = (counts.get(name) ?? 0) > 1 ? `${name} (${String(column.id)})` : name;
			return [String(column.id), key];
		}),
	);
}

/** Every row of a report with its answers keyed by column name, one item per row. */
async function getReportAnswers(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const reportId = locatorValue.call(this, 'report', itemIndex);
	const path = `/reports/${id(reportId)}`;
	const report = await wordsmithApi.call(this, 'GET', path);
	const columns = answerKeys((report.columns as IDataObject[] | undefined) ?? []);
	const all = Number.POSITIVE_INFINITY;
	const rows = await wordsmithList.call(this, `${path}/rows`, {}, all);
	const cells = await wordsmithList.call(this, `${path}/cells`, {}, all);
	const byRow = new Map<string, IDataObject[]>();
	for (const cell of cells) {
		const rowId = String(cell.row_id);
		byRow.set(rowId, [...(byRow.get(rowId) ?? []), cell]);
	}
	return rows.map((row) => {
		const answers: IDataObject = {};
		const statuses: IDataObject = {};
		for (const cell of byRow.get(String(row.id)) ?? []) {
			const name = columns.get(String(cell.column_id)) ?? String(cell.column_id);
			answers[name] = cell.value ?? null;
			statuses[name] = cell.status ?? null;
		}
		return item.call(this, itemIndex, {
			report_id: reportId,
			row_id: row.id,
			file_id: row.file_id ?? null,
			file_name: row.name ?? null,
			answers,
			statuses,
		});
	});
}

async function findReport(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	return await findPaged.call(this, itemIndex, '/reports');
}

async function addDocumentsToRepository(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<Result> {
	const repositoryId = locatorValue.call(this, 'repository', itemIndex);
	const fileIds = await documentIds.call(this, itemIndex);
	if (fileIds.length === 0) throw noDocuments.call(this, itemIndex);
	const body: IDataObject = { file_ids: fileIds };
	const folderId = (this.getNodeParameter('folderId', itemIndex, '') as string).trim();
	if (folderId) body.folder_id = folderId;
	const { operation: started, settings } = await startJob.call(
		this,
		itemIndex,
		`/repositories/${id(repositoryId)}/documents`,
		body,
	);
	if (!settings.wait) return [item.call(this, itemIndex, started)];
	const finished = await finishOperation.call(this, itemIndex, started, settings.maxWaitSeconds);
	const result = (finished.result ?? {}) as IDataObject;
	if (Number(result.indexed ?? 0) === 0 && Number(result.failed ?? 0) > 0) {
		throw withContext(
			new NodeOperationError(this.getNode(), 'Wordsmith could not index any of the documents', {
				itemIndex,
				description: `${String(result.failed)} documents failed to index in repository ${repositoryId}. Check the files, then retry the step.`,
			}),
			{ repository_id: repositoryId, failed: result.failed, operation_id: finished.id },
		);
	}
	return [
		item.call(this, itemIndex, {
			repository_id: repositoryId,
			indexed: result.indexed ?? null,
			failed: result.failed ?? null,
			operation_id: finished.id,
		}),
	];
}

async function findRepository(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	return await findPaged.call(this, itemIndex, '/repositories');
}

// ── Search ──────────────────────────────────────────────────────────────────────────

async function searchDocuments(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const body: IDataObject = {
		query: this.getNodeParameter('query', itemIndex) as string,
		limit: this.getNodeParameter('limit', itemIndex, 50),
	};
	const repositoryIds = splitList(this.getNodeParameter('repositoryIds', itemIndex, ''));
	if (repositoryIds.length > 0) body.repository_ids = repositoryIds;
	const found = await wordsmithApi.call(this, 'POST', '/search', { body });
	const results = (found.items as IDataObject[] | undefined) ?? [];
	const searched = splitList(found.searched_repository_ids);
	const missed = repositoryIds.filter((repositoryId) => !searched.includes(repositoryId));
	const scope =
		repositoryIds.length === 0
			? `Searched ${searched.length} repositories: your most recently active, up to 20.`
			: missed.length > 0
				? `Searched ${searched.length} of the ${repositoryIds.length} repositories asked for. Not searched: ${missed.join(', ')}.`
				: undefined;
	const lines = results.map((result) => `${String(result.file_name)}: ${String(result.snippet)}`);
	return [
		item.call(this, itemIndex, {
			...found,
			results_text: [...(scope ? [scope] : []), ...lines].join('\n\n'),
		}),
	];
}

async function searchLegalSources(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const options = this.getNodeParameter('researchOptions', itemIndex, {}) as IDataObject;
	const body: IDataObject = {
		query: this.getNodeParameter('query', itemIndex) as string,
		limit: this.getNodeParameter('limit', itemIndex, 50),
	};
	const jurisdictions = splitList(options.jurisdictions).map((code) => code.toLowerCase());
	if (jurisdictions.length > 0) body.jurisdictions = jurisdictions;
	if (options.dateFrom) body.date_from = String(options.dateFrom).slice(0, 10);
	if (options.dateTo) body.date_to = String(options.dateTo).slice(0, 10);
	return [
		item.call(this, itemIndex, await wordsmithApi.call(this, 'POST', '/research/search', { body })),
	];
}

async function getLegalSourceDocument(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const source = String(this.getNodeParameter('source', itemIndex)).trim();
	const qs: IDataObject = {
		document_id: String(this.getNodeParameter('documentId', itemIndex)).trim(),
		max_chars: this.getNodeParameter('maxChars', itemIndex, 20000),
	};
	const offset = this.getNodeParameter('offset', itemIndex, 0) as number;
	if (offset > 0) qs.offset = offset;
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'GET', `/research/documents/${id(source)}`, { qs }),
		),
	];
}

async function cancelOperation(this: IExecuteFunctions, itemIndex: number): Promise<Result> {
	const operationId = String(this.getNodeParameter('operationId', itemIndex)).trim();
	return [
		item.call(
			this,
			itemIndex,
			await wordsmithApi.call(this, 'POST', `/operations/${id(operationId)}/cancel`),
		),
	];
}

export const OPERATIONS: Record<
	string,
	(this: IExecuteFunctions, itemIndex: number, operation: string) => Promise<Result>
> = {
	ask_agent: askAgent,
	get_question: getQuestion,
	upload_file: uploadFile,
	get_file: getFile,
	redline_document: documentAction,
	compare_documents: documentAction,
	convert_document: documentAction,
	run_review: runReview,
	get_review: getReview,
	draft_document: draftDocument,
	create_task: createTask,
	update_task: updateTask,
	add_task_comment: addTaskComment,
	attach_files_to_task: attachFilesToTask,
	find_task: findTask,
	get_operation: getOperation,
	find_agent: findAgent,
	import_file_from_url: importFileFromUrl,
	create_document: createDocument,
	get_file_text: getFileText,
	translate_document: documentAction,
	redact_document: documentAction,
	accept_all_changes: documentAction,
	merge_pdfs: documentAction,
	generate_review_redline: generateReviewRedline,
	reply_to_task_requester: replyToTaskRequester,
	get_task_files: getTaskFiles,
	create_report: createReport,
	add_report_rows: addReportRows,
	run_report: runReport,
	export_report: exportReport,
	find_report: findReport,
	add_documents_to_repository: addDocumentsToRepository,
	find_repository: findRepository,
	search_documents: searchDocuments,
	search_legal_sources: searchLegalSources,
	find_conversation: findConversation,
	find_user: findUser,
	get_report_answers: getReportAnswers,
	get_conversation_messages: getConversationMessages,
	get_legal_source_document: getLegalSourceDocument,
	cancel_operation: cancelOperation,
};
