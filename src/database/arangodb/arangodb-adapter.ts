import { DatabaseAdapter } from '../database-adapter';
import { QueryNode } from '../../query/definition';
import { getAQLQuery } from './aql-generator';
import { Database } from 'arangojs';
import { getNamedType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { flatMap, objectValues } from '../../utils/utils';
import { isRelationField, isRootEntityType } from '../../schema/schema-utils';
import { getEdgeType } from '../../schema/edges';
import { getCollectionNameForEdge, getCollectionNameForRootEntity } from './arango-basics';
import { globalContext, Logger, SchemaContext } from '../../config/global';
import { AQLCompoundQuery, AQLExecutableQuery } from './aql';
import { ALL_QUERY_RESULT_VALIDATOR_FUNCTION_PROVIDERS } from '../../query/query-result-validators';
import { calculateRequiredIndexOperations, getRequiredIndicesFromSchema, IndexDefinition } from '../index-definition';

const DEFAULT_INDEX_TYPE = 'persistent'; // persistent is a skiplist index

export interface ArangoDBConfig {
    readonly url: string;
    readonly user?: string;
    readonly password?: string;
    readonly databaseName: string;
    readonly autocreateIndices?: boolean;
    readonly autoremoveIndices?: boolean;
}

export class ArangoDBAdapter implements DatabaseAdapter {
    private db: Database;
    private logger: Logger;
    readonly autocreateIndices?: boolean;
    readonly autoremoveIndices?: boolean;
    private readonly arangoExecutionFunction: string;

    constructor(config: ArangoDBConfig, private schemaContext?: SchemaContext) {
        globalContext.registerContext(schemaContext);
        try {
            this.logger = globalContext.loggerProvider.getLogger("ArangoDBAdapter");
        } finally {
            globalContext.unregisterContext();
        }
        this.db = new Database({
            url: config.url,
            databaseName: config.databaseName
        });
        if(config.user) {
            // Unfortunately the typings of arangojs do not include the method "useBasicAuth" although it is present in the implementation of arangojs.
            // Therefore we cast to any
            (this.db as any).useBasicAuth(config.user, config.password);
        }

        this.arangoExecutionFunction = this.buildUpArangoExecutionFunction();
        this.autocreateIndices = config.autocreateIndices;
        this.autoremoveIndices = config.autoremoveIndices;
    }

    /**
     * Gets the javascript source code for a function that executes a transaction
     * @returns {string}
     */
    private buildUpArangoExecutionFunction(): string {

        // The following function will be translated to a string and executed (as one transaction) within the
        // ArangoDB server itself. Therefore the next comment is necessary to instruct our test coverage tool
        // (https://github.com/istanbuljs/nyc) not to instrument the code with coverage instructions.

        /* istanbul ignore next */
        const arangoExecutionFunction = function (queries: AQLExecutableQuery[]) {
            const db = require("@arangodb").db;

            let validators: {[name:string]: (validationData: any, result:any) => void} = {};
            //inject_validators_here

            let resultHolder: {[p: string]: any} = {};
            for (const query of queries) {
                const boundValues = query.boundValues;
                for (const key in query.usedPreExecResultNames) {
                    boundValues[query.usedPreExecResultNames[key]] = resultHolder[key];
                }

                // Execute the AQL query
                const result = db._query(query.code, boundValues).next();

                if (query.resultName) {
                    resultHolder[query.resultName] = result;
                }

                if (query.resultValidator) {
                    for (const key in query.resultValidator) {
                        if (key in validators) {
                            validators[key](query.resultValidator[key], result);
                        }
                    }
                }
            }

            // the last query is always the main query, use its result as result of the transaction
            const lastQueryResultName = queries[queries.length - 1].resultName;
            if (lastQueryResultName) {
                return resultHolder[lastQueryResultName];
            } else {
                return undefined;
            }
        };


        const validatorProviders = ALL_QUERY_RESULT_VALIDATOR_FUNCTION_PROVIDERS.map(provider =>
            `[${JSON.stringify(provider.getValidatorName())}]: ${String(provider.getValidatorFunction())}`);

        const allValidatorFunctionsObjectString = `validators = {${validatorProviders.join(',\n')}}`;

        return String(arangoExecutionFunction)
            .replace('//inject_validators_here', allValidatorFunctionsObjectString);
    }


    async execute(queryTree: QueryNode) {
        globalContext.registerContext(this.schemaContext);
        let executableQueries: AQLExecutableQuery[];
        let aqlQuery: AQLCompoundQuery;
        try {
            //TODO Execute single statement AQL queries directly without "db.transaction"?
            aqlQuery = getAQLQuery(queryTree);
            executableQueries = aqlQuery.getExecutableQueries();
        } finally {
            globalContext.unregisterContext();
        }
        this.logger.debug(aqlQuery.toColoredString());

        return await this.db.transaction(
            {
                read: aqlQuery.readAccessedCollections,
                write: aqlQuery.writeAccessedCollections
            },
            this.arangoExecutionFunction,
            executableQueries
        );
    }

    async updateSchema(schema: GraphQLSchema): Promise<void> {
        const rootEntities = objectValues(schema.getTypeMap()).filter(type => isRootEntityType(type)) as GraphQLObjectType[];
        const edgeTypes = flatMap(rootEntities, entity =>
            objectValues(entity.getFields())
                .filter(field => isRelationField(field))
                .map(field => getEdgeType(entity, field)));

        // Get existing collections in ArangoDB
        const collections = await this.db.collections();

        // Creating missing document collections in ArangoDB
        const requiredCollections = rootEntities.map(entity => getCollectionNameForRootEntity(entity));
        const existingCollections = collections.map(coll => (<any>coll).name); // typing for name missing
        const collectionsToCreate = requiredCollections.filter(c => existingCollections.indexOf(c) < 0);
        this.logger.info(`Creating collections ${collectionsToCreate.join(', ')}...`);
        const createTasks = collectionsToCreate.map(col => this.db.collection(col.toString()).create({waitForSync: false}));
        await Promise.all(createTasks);
        this.logger.info(`Done`);

        // update indices
        const requiredIndices = getRequiredIndicesFromSchema(schema);
        pimpListsWithAsterisk(requiredIndices);
        const existingIndicesPromises = rootEntities.map(entity => this.getCollectionIndices(entity));
        let existingIndices: IndexDefinition[] = [];
        await Promise.all(existingIndicesPromises).then(promiseResults => promiseResults.forEach(indices => indices.forEach(index => existingIndices.push(index))));
        const { indicesToDelete, indicesToCreate } = calculateRequiredIndexOperations(existingIndices, requiredIndices);
        const deleteIndicesPromises = indicesToDelete.map(indexToDelete => {
            const collection = getCollectionNameForRootEntity(indexToDelete.rootEntity);
            if (indexToDelete.id.endsWith('/0')) {
                // Don't delete primary indices
                return;
            }
            if (this.autoremoveIndices) {
                this.logger.info(`Dropping index ${indexToDelete.id} on ${indexToDelete.fields.length > 1 ? 'fields' : 'field'} '${indexToDelete.fields.join(',')}'`);
                return this.db.collection(collection).dropIndex(indexToDelete.id);
            } else {
                this.logger.info(`Skipping removal of index ${indexToDelete.id} on ${indexToDelete.fields.length > 1 ? 'fields' : 'field'} '${indexToDelete.fields.join(',')}'`);
                return undefined;
            }
        });
        await Promise.all(deleteIndicesPromises);

        const createIndicesPromises = indicesToCreate.map(indexToCreate => {
            const collection = getCollectionNameForRootEntity(indexToCreate.rootEntity);
            if (this.autocreateIndices !== false) {
                this.logger.info(`Creating ${ indexToCreate.unique ? 'unique ' : ''}index on collection ${collection} on ${indexToCreate.fields.length > 1 ? 'fields' : 'field'} '${indexToCreate.fields.join(',')}'`);
                return this.db.collection(collection).createIndex({
                    fields: indexToCreate.fields,
                    unique: indexToCreate.unique,
                    type: DEFAULT_INDEX_TYPE
                })
            } else {
                this.logger.info(`Skipping creation of ${ indexToCreate.unique ? 'unique ' : ''}index on collection ${collection} on ${indexToCreate.fields.length > 1 ? 'fields' : 'field'} '${indexToCreate.fields.join(',')}'`);
                return undefined;
            }
        });
        await Promise.all(createIndicesPromises);

        // Creating missing edge collections in ArangoDB
        const requiredEdgeCollections = Array.from(new Set(edgeTypes.map(edge => getCollectionNameForEdge(edge))));
        const existingEdgeCollections = collections.map(coll => (<any>coll).name); // typing for name missing
        const edgeCollectionsToCreate = requiredEdgeCollections.filter(c => existingEdgeCollections.indexOf(c) < 0);
        this.logger.info(`Creating edge collections ${edgeCollectionsToCreate.join(', ')}...`);
        const createEdgeTasks = edgeCollectionsToCreate.map(col => this.db.edgeCollection(col.toString()).create({waitForSync: false}));
        await Promise.all(createEdgeTasks);
        this.logger.info(`Done`);
    }

    async getCollectionIndices(rootEntity: GraphQLObjectType): Promise<IndexDefinition[]> {
        const collectionName = getCollectionNameForRootEntity(rootEntity);
        return this.db.collection(collectionName).indexes().then(result => result.map(index => {
            return {...index, rootEntity }
        }));
    }
}

function pimpListsWithAsterisk(indexDefinitions: IndexDefinition[]) {
    indexDefinitions.forEach(indexDefinition => {
        indexDefinition.fields = indexDefinition.fields.map(field => {
            const splitField = field.split('.');
            let currentNodeOnPath = indexDefinition.rootEntity;
            let currentFieldIndex: number = 0;
            while (currentFieldIndex < splitField.length) {
                const field = (currentNodeOnPath as GraphQLObjectType).getFields()[splitField[currentFieldIndex]];
                if (field.type instanceof GraphQLList || (field.type instanceof GraphQLNonNull && field.type.ofType instanceof GraphQLList)) {
                    splitField[currentFieldIndex] += "[*]";
                }
                currentFieldIndex++;
                currentNodeOnPath = getNamedType(field.type);
            }
            return splitField.join('.');
        });
    })
}
