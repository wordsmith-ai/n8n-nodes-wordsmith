import type {
	FieldType,
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';

import { id, wordsmithApi } from './transport';

interface Named {
	id: string;
	name: string;
	url?: string | null;
}

function matching(items: Named[], filter?: string): INodeListSearchItems[] {
	const needle = filter?.trim().toLowerCase();
	return items
		.filter((item) => !needle || item.name.toLowerCase().includes(needle))
		.map((item) => ({ name: item.name, value: item.id, url: item.url ?? undefined }));
}

export async function searchAgents(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const agents = (await wordsmithApi.call(this, 'GET', '/agents')) as unknown as Named[];
	const general = { name: 'Wordsmith (General Agent)', value: 'default' };
	const showGeneral = !filter || general.name.toLowerCase().includes(filter.trim().toLowerCase());
	return { results: [...(showGeneral ? [general] : []), ...matching(agents, filter)] };
}

export async function searchTaskAgents(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const agents = (await wordsmithApi.call(this, 'GET', '/agents', {
		qs: { task_assignable: 'true' },
	})) as unknown as Named[];
	return { results: matching(agents, filter) };
}

export async function searchPlaybooks(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const playbooks = (await wordsmithApi.call(this, 'GET', '/playbooks')) as unknown as Named[];
	return { results: matching(playbooks, filter) };
}

export async function searchBlueprints(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const qs: IDataObject = { published: 'true', limit: 100 };
	if (filter) qs.query = filter;
	if (paginationToken) qs.cursor = paginationToken;
	const page = (await wordsmithApi.call(this, 'GET', '/blueprints', { qs })) as unknown as {
		items: Named[];
		cursor: string | null;
	};
	return { results: matching(page.items), paginationToken: page.cursor ?? undefined };
}

/** A paged list route searched by name with `query`, one page per call. */
async function searchPaged(
	this: ILoadOptionsFunctions,
	path: string,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const qs: IDataObject = { limit: 100 };
	if (filter?.trim()) qs.query = filter.trim();
	if (paginationToken) qs.cursor = paginationToken;
	const page = (await wordsmithApi.call(this, 'GET', path, { qs })) as unknown as {
		items: Named[];
		cursor: string | null;
	};
	return { results: matching(page.items), paginationToken: page.cursor ?? undefined };
}

export async function searchReports(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return await searchPaged.call(this, '/reports', filter, paginationToken);
}

export async function searchRepositories(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return await searchPaged.call(this, '/repositories', filter, paginationToken);
}

export async function searchUsers(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const users = (await wordsmithApi.call(this, 'GET', '/users', {
		qs: { active_only: 'true', human_only: 'true' },
	})) as unknown as Array<{ name: string | null; email: string }>;
	const needle = filter?.trim().toLowerCase();
	return {
		results: users
			.filter(
				(user) =>
					!needle ||
					user.email.toLowerCase().includes(needle) ||
					(user.name ?? '').toLowerCase().includes(needle),
			)
			.map((user) => ({
				name: user.name ? `${user.name} (${user.email})` : user.email,
				value: user.email,
			})),
	};
}

interface Placeholder {
	key: string;
	label: string | null;
	type: 'text' | 'choice' | 'multi_choice' | 'boolean' | 'table';
	required: boolean;
	description: string | null;
	options: string[] | null;
}

const PLACEHOLDER_TYPES: Record<Placeholder['type'], FieldType> = {
	text: 'string',
	choice: 'options',
	multi_choice: 'array',
	boolean: 'boolean',
	table: 'array',
};

/** One field per placeholder of the chosen blueprint, for the Draft a document mapper. */
export function placeholderFields(placeholders: Placeholder[]): ResourceMapperField[] {
	return placeholders.map((placeholder) => ({
		id: placeholder.key,
		displayName: placeholder.label || placeholder.key,
		required: placeholder.required,
		defaultMatch: false,
		display: true,
		type: PLACEHOLDER_TYPES[placeholder.type] ?? 'string',
		options:
			placeholder.type === 'choice'
				? (placeholder.options ?? []).map((option) => ({ name: option, value: option }))
				: undefined,
	}));
}

export async function getBlueprintFields(
	this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
	const blueprintId = this.getNodeParameter('blueprint', undefined, {
		extractValue: true,
	}) as string;
	if (!blueprintId) {
		return { fields: [], emptyFieldsNotice: 'Choose a blueprint to fill in its fields.' };
	}
	const blueprint = await wordsmithApi.call(this, 'GET', `/blueprints/${id(blueprintId)}`);
	const fields = placeholderFields((blueprint.placeholders as unknown as Placeholder[]) ?? []);
	return {
		fields,
		emptyFieldsNotice: 'This blueprint has no fields. Describe the draft in Instructions.',
	};
}

export async function getEventTypes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const { items } = (await wordsmithApi.call(this, 'GET', '/event_types')) as unknown as {
		items: Array<{ type: string; description: string }>;
	};
	const options: INodePropertyOptions[] = [];
	const resources = new Set<string>();
	for (const item of items) {
		if (item.type === 'webhook_endpoint.test') continue;
		options.push({ name: item.type, value: item.type, description: item.description });
		if (item.type.includes('.')) resources.add(item.type.split('.')[0]);
	}
	for (const resource of resources) {
		options.push({
			name: `${resource}.*`,
			value: `${resource}.*`,
			description: `Every ${resource} event, including types added later`,
		});
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}
