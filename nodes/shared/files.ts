import { createHash } from 'crypto';
import type { IBinaryData, IDataObject, IExecuteFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

import { id, splitList, wordsmithApi } from './transport';

const UPLOADS_KEPT = 500;
const uploadedFiles = new Map<string, IDataObject>();

/**
 * Files this process already uploaded for a step, by execution, node, run, item, field and content. n8n's Retry
 * On Fail reruns the step in the same process: reusing the file keeps the retried start call's body, and so
 * its Idempotency-Key, identical, and the API returns the first operation instead of refusing the retry.
 */
function rememberUpload(key: string, file: IDataObject): void {
	uploadedFiles.set(key, file);
	if (uploadedFiles.size > UPLOADS_KEPT) {
		uploadedFiles.delete(uploadedFiles.keys().next().value as string);
	}
}

/**
 * Stores an item's binary field in the caller's private space with the presigned flow: upload URL, PUT, then
 * complete. The PUT carries no Authorization header and the same Content-Type the URL was signed for.
 */
export async function uploadBinary(
	this: IExecuteFunctions,
	itemIndex: number,
	binaryPropertyName: string,
	fileNameOverride?: string,
): Promise<IDataObject> {
	const binary = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
	const fileName = fileNameOverride || binary.fileName || binaryPropertyName;
	const contentType = binary.mimeType || 'application/octet-stream';
	const cacheKey = [
		this.getExecutionId(),
		this.getNode().name,
		this.getWorkflowDataProxy(itemIndex).$runIndex,
		itemIndex,
		binaryPropertyName,
		fileName,
		createHash('sha256').update(buffer).digest('hex'),
	].join(':');
	const uploaded = uploadedFiles.get(cacheKey);
	if (uploaded) return uploaded;
	const job = await wordsmithApi.call(this, 'POST', '/files/upload-url', {
		body: { file_name: fileName, content_type: contentType, content_length: buffer.length },
	});
	try {
		await this.helpers.httpRequest({
			method: 'PUT',
			url: job.upload_url as string,
			body: buffer,
			headers: { 'Content-Type': contentType },
			json: false,
		});
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			itemIndex,
			message: `Could not send “${fileName}” to Wordsmith’s file storage`,
		});
	}
	const file = await wordsmithApi.call(this, 'POST', `/files/uploads/${id(job.job_id)}/complete`);
	rememberUpload(cacheKey, file);
	return file;
}

/** File ids for a files input: uploads each named binary field, then adds the given ids. */
export async function collectFileIds(
	this: IExecuteFunctions,
	itemIndex: number,
	binaryFields: unknown,
	fileIds: unknown,
): Promise<string[]> {
	const ids: string[] = [];
	for (const field of splitList(binaryFields)) {
		const file = await uploadBinary.call(this, itemIndex, field);
		ids.push(String(file.id));
	}
	return [...ids, ...splitList(fileIds)];
}

/** The file id for a single-file input, uploading the binary field when the source is binary. */
export async function resolveFileInput(
	this: IExecuteFunctions,
	itemIndex: number,
	prefix: string,
): Promise<string> {
	const source = this.getNodeParameter(`${prefix}Source`, itemIndex) as string;
	if (source === 'binary') {
		const field = this.getNodeParameter(`${prefix}BinaryField`, itemIndex) as string;
		return String((await uploadBinary.call(this, itemIndex, field)).id);
	}
	return String(this.getNodeParameter(`${prefix}Id`, itemIndex)).trim();
}

export interface DownloadedFile {
	json: { file_id: string; file_name: string | null; content_type: string | null; web_url: string };
	binary: IBinaryData;
}

/**
 * Reads a file's signed download link and fetches it in the same step, since the link lasts five minutes.
 * Outputs `web_url` for people, never the signed link.
 */
export async function downloadFile(
	this: IExecuteFunctions,
	fileId: string,
	downloadPath = `/files/${id(fileId)}/download`,
): Promise<DownloadedFile> {
	const link = await wordsmithApi.call(this, 'GET', downloadPath);
	const data = (await this.helpers.httpRequest({
		method: 'GET',
		url: link.url as string,
		encoding: 'arraybuffer',
		json: false,
	})) as ArrayBuffer;
	const fileName = (link.file_name as string | null) ?? null;
	const contentType = (link.content_type as string | null) ?? null;
	const binary = await this.helpers.prepareBinaryData(
		Buffer.from(data),
		fileName ?? String(fileId),
		contentType ?? undefined,
	);
	return {
		json: {
			file_id: String(link.file_id ?? fileId),
			file_name: fileName,
			content_type: contentType,
			web_url: link.web_url as string,
		},
		binary,
	};
}
