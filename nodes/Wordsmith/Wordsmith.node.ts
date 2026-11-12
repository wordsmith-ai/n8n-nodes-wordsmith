import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	getBlueprintFields,
	searchAgents,
	searchBlueprints,
	searchPlaybooks,
	searchTaskAgents,
	searchUsers,
} from '../shared/methods';
import { authenticationProperties, credentialsFor, NODE_VERSIONS } from '../shared/transport';
import { OPERATIONS } from './actions';
import { agentProperties } from './descriptions/agent';
import { documentProperties, fileProperties } from './descriptions/fileDocument';
import { draftProperties, reviewProperties } from './descriptions/reviewDraft';
import { jobProperties, taskProperties } from './descriptions/taskJob';

/**
 * 0.1.0 of this npm package had a node of the same name at version 1, and that is the only version 1 ever
 * published. Its saved parameters can't identify it: n8n omits defaults, and both nodes have a `question` field.
 */
export function savedByFirstRelease(node: INode): boolean {
	return node.typeVersion === 1;
}

export class Wordsmith implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Wordsmith',
		name: 'wordsmith',
		icon: { light: 'file:wordsmith.svg', dark: 'file:wordsmith.dark.svg' },
		group: ['transform'],
		...NODE_VERSIONS,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Ask Wordsmith legal agents, review, redline, compare and draft documents, and manage tasks',
		defaults: { name: 'Wordsmith' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: credentialsFor(),
		properties: [
			{
				displayName:
					'This node was added with version 0.1.0 of the package and no longer runs. Add the Wordsmith node again, choose the action you need, and remove this node.',
				name: 'firstReleaseNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { '@version': [1] } },
			},
			...authenticationProperties,
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Agent', value: 'agent' },
					{ name: 'Document', value: 'document' },
					{ name: 'Draft', value: 'draft' },
					{ name: 'File', value: 'file' },
					{ name: 'Job', value: 'job' },
					{ name: 'Review', value: 'review' },
					{ name: 'Task', value: 'task' },
				],
				default: 'agent',
			},
			...agentProperties,
			...documentProperties,
			...draftProperties,
			...fileProperties,
			...jobProperties,
			...reviewProperties,
			...taskProperties,
		],
	};

	methods = {
		listSearch: {
			searchAgents,
			searchBlueprints,
			searchPlaybooks,
			searchTaskAgents,
			searchUsers,
		},
		resourceMapping: { getBlueprintFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		if (savedByFirstRelease(this.getNode())) {
			throw new NodeOperationError(
				this.getNode(),
				'This Wordsmith node was added with version 0.1.0 of the package',
				{
					description:
						'Version 0.2.0 replaced its actions. Add the Wordsmith node to this workflow again, choose the action you need, and remove this node.',
				},
			);
		}
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const run = OPERATIONS[operation];
				if (!run) {
					throw new NodeOperationError(this.getNode(), `Unknown operation “${operation}”`, {
						itemIndex,
					});
				}
				returnData.push(...(await run.call(this, itemIndex, operation)));
			} catch (error) {
				if (this.continueOnFail()) {
					// Keep the description and ids (such as the job to read later), not only the message.
					const { description, context } = error as { description?: string; context?: IDataObject };
					returnData.push({
						json: { error: (error as Error).message, description: description ?? null, ...context },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				// Both constructors return an error of their own class unchanged.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject);
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}
		return [returnData];
	}
}
