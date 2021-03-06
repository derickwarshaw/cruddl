import {
    AddEdgesQueryNode, BasicType, BinaryOperationQueryNode, BinaryOperator, ConcatListsQueryNode, ConditionalQueryNode,
    ConstBoolQueryNode, ConstIntQueryNode, CountQueryNode, CreateEntityQueryNode, DeleteEntitiesQueryNode, EdgeFilter,
    EdgeIdentifier,
    EntitiesQueryNode, EntityFromIdQueryNode, FieldQueryNode, FirstOfListQueryNode, FollowEdgeQueryNode, ListQueryNode,
    LiteralQueryNode, MergeObjectsQueryNode, ObjectQueryNode, OrderDirection, OrderSpecification, PartialEdgeIdentifier,
    QueryNode, RemoveEdgesQueryNode, RootEntityIDQueryNode, RuntimeErrorQueryNode, SetEdgeQueryNode,
    TransformListQueryNode, TypeCheckQueryNode, UnaryOperationQueryNode, UnaryOperator, UpdateEntitiesQueryNode,
    VariableAssignmentQueryNode, VariableQueryNode, WithPreExecutionQueryNode
} from '../../query/definition';
import { aql, AQLCompoundQuery, AQLFragment, AQLQueryResultVariable, AQLVariable } from './aql';
import { getCollectionNameForEdge, getCollectionNameForRootEntity } from './arango-basics';
import { GraphQLNamedType, GraphQLObjectType } from 'graphql';
import { EdgeType, RelationFieldEdgeSide } from '../../schema/edges';
import { simplifyBooleans } from '../../query/query-tree-utils';
import { QueryResultValidator } from '../../query/query-result-validators';
import { RUNTIME_ERROR_TOKEN } from '../../query/runtime-errors';

enum AccessType {
    READ,
    WRITE
}

class QueryContext {
    private variableMap = new Map<VariableQueryNode, AQLVariable>();
    private preExecQueries: AQLCompoundQuery[] = [];
    private readAccessedCollections = new Set<string>();
    private writeAccessedCollections = new Set<string>();

    /**
     * Creates a new QueryContext with an independent variable map except that all query result variables of this
     * context are available.
     */
    private newPreExecContext(): QueryContext{
        const newContext = new QueryContext();
        this.variableMap.forEach((aqlVar, varNode) => {
            if (aqlVar instanceof AQLQueryResultVariable) {
                newContext.variableMap.set(varNode, aqlVar);
            }
        });
        newContext.readAccessedCollections = this.readAccessedCollections;
        newContext.writeAccessedCollections = this.writeAccessedCollections;
        return newContext;
    }

    /**
     * Creates a new QueryContext that is identical to this one but has one additional variable binding
     * @param variableNode the variable token as it is referenced in the query tree
     * @param aqlVariable the variable token as it will be available within the AQL fragment
     */
    private newNestedContextWithNewVariable(variableNode: VariableQueryNode, aqlVariable: AQLVariable): QueryContext {
        if (this.variableMap.has(variableNode)) {
            throw new Error(`Variable ${variableNode} is introduced twice`);
        }
        const newContext = new QueryContext();
        newContext.variableMap = new Map(this.variableMap);
        newContext.variableMap.set(variableNode, aqlVariable);
        newContext.preExecQueries = this.preExecQueries;
        newContext.readAccessedCollections = this.readAccessedCollections;
        newContext.writeAccessedCollections = this.writeAccessedCollections;
        return newContext;
    }

    /**
     * Creates a new QueryContext that is identical to this one but has one additional variable binding
     *
     * The AQLFragment for the variable will be available via getVariable().
     *
     * @param {VariableQueryNode} variableNode the variable as referenced in the query tree
     * @returns {QueryContext} the nested context
     */
    introduceVariable(variableNode: VariableQueryNode): QueryContext {
        const variable = new AQLVariable(variableNode.label);
        return this.newNestedContextWithNewVariable(variableNode, variable);
    }

    /**
     * Creates a new QueryContext that includes an additional transaction step and adds resultVariable to the scope
     * which will contain the result of the query
     *
     * The preExecQuery is evaluated in an independent context that has access to all previous preExecQuery result
     * variables.
     *
     * @param preExecQuery the query to execute as transaction step
     * @param resultVariable the variable to store the query result
     * @param resultValidator an optional validator for the query result
     */
    addPreExecuteQuery(preExecQuery: QueryNode, resultVariable?: VariableQueryNode, resultValidator?: QueryResultValidator): QueryContext {
        let resultVar: AQLQueryResultVariable|undefined;
        let newContext: QueryContext;
        if (resultVariable) {
            resultVar = new AQLQueryResultVariable(resultVariable.label)
            newContext = this.newNestedContextWithNewVariable(resultVariable, resultVar);
        } else {
            resultVar = undefined;
            newContext = this;
        }

        const aqlQuery = createAQLCompoundQuery(preExecQuery, resultVar, resultValidator, this.newPreExecContext());

        this.preExecQueries.push(aqlQuery);
        return newContext;
    }

    /**
     * Adds the information (in-place) that a collection is accessed
     */
    addCollectionAccess(collection: string, accessType: AccessType): void {
        switch (accessType) {
            case AccessType.READ:
                this.readAccessedCollections.add(collection);
                break;
            case AccessType.WRITE:
                this.writeAccessedCollections.add(collection);
                break;
        }
    }

    /**
     * Gets an AQLFragment that evaluates to the value of a variable in the current scope
     */
    getVariable(variableNode: VariableQueryNode): AQLFragment {
        const variable = this.variableMap.get(variableNode);
        if (!variable) {
            throw new Error(`Variable ${variableNode.toString()} is used but not introduced`);
        }
        return aql`${variable}`;
    }

    getPreExecuteQueries(): AQLCompoundQuery[] {
        return this.preExecQueries;
    }

    getReadAccessedCollections(): string[]{
        return Array.from(this.readAccessedCollections);
    }

    getWriteAccessedCollections(): string[]{
        return Array.from(this.writeAccessedCollections);
    }
}

function createAQLCompoundQuery(node: QueryNode,
                                resultVariable: AQLQueryResultVariable|undefined,
                                resultValidator: QueryResultValidator|undefined,
                                context: QueryContext): AQLCompoundQuery {
    const aqlQuery = aql`RETURN ${processNode(node, context)}`;
    const preExecQueries = context.getPreExecuteQueries();
    const readAccessedCollections = context.getReadAccessedCollections();
    const writeAccessedCollections = context.getWriteAccessedCollections();

    return new AQLCompoundQuery(preExecQueries, aqlQuery, resultVariable, resultValidator, readAccessedCollections, writeAccessedCollections);
}

type NodeProcessor<T extends QueryNode> = (node: T, context: QueryContext) => AQLFragment;

namespace aqlExt {
    export function safeJSONKey(key: string): AQLFragment {
        if (aql.isSafeIdentifier(key)) {
            return aql`${aql.string(key)}`; // if safe, use "name" approach
        } else {
            return aql`${key}`; // fall back to bound values
        }
    }

    export function parenthesizeList(...content: AQLFragment[]): AQLFragment {
        return aql.lines(
            aql`(`,
            aql.indent(aql.lines(...content)),
            aql`)`
        );
    }

    export function parenthesizeObject(...content: AQLFragment[]): AQLFragment {
        return aql`FIRST${parenthesizeList(...content)}`;
    }
}

const processors : { [name: string]: NodeProcessor<any> } = {
    Literal(node: LiteralQueryNode): AQLFragment {
        return aql`${node.value}`;
    },

    Null(): AQLFragment {
        return aql`null`;
    },

    RuntimeError(node: RuntimeErrorQueryNode): AQLFragment {
        const runtimeErrorToken = aql.code(RUNTIME_ERROR_TOKEN);
        return aql`{${runtimeErrorToken}: ${node.message}}`;
    },

    ConstBool(node: ConstBoolQueryNode): AQLFragment {
        return node.value ? aql`true` : aql`false`;
    },

    ConstInt(node: ConstIntQueryNode): AQLFragment {
        return aql.integer(node.value);
    },

    Object(node: ObjectQueryNode, context): AQLFragment {
        if (!node.properties.length) {
            return aql`{}`;
        }

        const properties = node.properties.map(p =>
            aql`${aqlExt.safeJSONKey(p.propertyName)}: ${processNode(p.valueNode, context)}`);
        return aql.lines(
            aql`{`,
            aql.indent(aql.join(properties, aql`,\n`)),
            aql`}`
        );
    },

    List(node: ListQueryNode, context): AQLFragment {
        if (!node.itemNodes.length) {
            return aql`[]`;
        }

        return aql.lines(
            aql`[`,
            aql.indent(aql.join(node.itemNodes.map(itemNode => processNode(itemNode, context)), aql`,\n`)),
            aql`]`
        );
    },

    ConcatLists(node: ConcatListsQueryNode, context): AQLFragment {
        const listNodes = node.listNodes.map(node => processNode(node, context));
        const listNodeStr = aql.join(listNodes, aql`, `);
        // note: UNION just appends, there is a special UNION_DISTINCT to filter out duplicates
        return aql`UNION(${listNodeStr})`;
    },

    Variable(node: VariableQueryNode, context): AQLFragment {
        return context.getVariable(node);
    },

    VariableAssignment(node: VariableAssignmentQueryNode, context): AQLFragment {
        const newContext = context.introduceVariable(node.variableNode);
        const tmpVar = newContext.getVariable(node.variableNode);

        // note that we have to know statically if the context var is a list or an object
        // assuming object here because lists are not needed currently
        return aqlExt.parenthesizeObject(
            aql`LET ${tmpVar} = ${processNode(node.variableValueNode, newContext)}`,
            aql`RETURN ${processNode(node.resultNode, newContext)}`
        );
    },

    WithPreExecution(node: WithPreExecutionQueryNode, context): AQLFragment {
        let currentContext = context;
        for (const preExecParm of node.preExecQueries) {
            currentContext = currentContext.addPreExecuteQuery(preExecParm.query, preExecParm.resultVariable, preExecParm.resultValidator);
        }

        return aql`${processNode(node.resultNode, currentContext)}`;
    },

    EntityFromId(node:  EntityFromIdQueryNode, context): AQLFragment {
        const collection = getCollectionForType(node.objectType, AccessType.READ, context);
        return aql`DOCUMENT(${collection}, ${processNode(node.idNode, context)})`;
    },

    Field(node: FieldQueryNode, context): AQLFragment {
        const object = processNode(node.objectNode, context);
        let identifier = node.field.name;
        if (aql.isSafeIdentifier(identifier)) {
            return aql`${object}.${aql.identifier(identifier)}`;
        }
        // fall back to bound values. do not attempt aql.string for security reasons - should not be the case normally, anyway.
        return aql`${object}[${identifier}]`;
    },

    RootEntityID(node: RootEntityIDQueryNode, context): AQLFragment {
        return aql`${processNode(node.objectNode, context)}._key`; // ids are stored in _key field
    },

    TransformList(node: TransformListQueryNode, context): AQLFragment {
        let itemContext = context.introduceVariable(node.itemVariable);
        const itemVar = itemContext.getVariable(node.itemVariable);

        let list: AQLFragment;
        let filterDanglingEdges = aql``;
        if (node.listNode instanceof FollowEdgeQueryNode) {
            list = getSimpleFollowEdgeFragment(node.listNode, context);
            filterDanglingEdges = aql`FILTER ${itemVar} != null`;
        } else {
            list = processNode(node.listNode, context);
        }
        let filter = simplifyBooleans(node.filterNode);

        return aqlExt.parenthesizeList(
            aql`FOR ${itemVar}`,
            aql`IN ${list}`,
            (filter instanceof ConstBoolQueryNode && filter.value) ? aql`` : aql`FILTER ${processNode(filter, itemContext)}`,
            filterDanglingEdges,
            generateSortAQL(node.orderBy, itemContext),
            node.maxCount != undefined ? aql`LIMIT ${node.maxCount}` : aql``,
            aql`RETURN ${processNode(node.innerNode, itemContext)}`
        );
    },

    Count(node: CountQueryNode, context): AQLFragment {
        if (node.listNode instanceof FieldQueryNode || node.listNode instanceof EntitiesQueryNode) {
            // These cases are known to be optimized
            // TODO this does not catch the safe-list case (list ? list : []), where we could optimize to (list ? LENGTH(list) : 0)
            // so we probably need to add an optimization to the query tree builder
            return aql`LENGTH(${processNode(node.listNode, context)})`;
        }

        // in the general case (mostly a TransformListQueryNode), it is better to use the COLLeCT WITH COUNT syntax
        // because it avoids building the whole collection temporarily in memory
        // however, https://docs.arangodb.com/3.2/AQL/Examples/Counting.html does not really mention this case, so we
        // should evaluate it again
        const itemVar = aql.variable('item');
        const countVar = aql.variable('count');
        return aqlExt.parenthesizeObject(
            aql`FOR ${itemVar}`,
            aql`IN ${processNode(node.listNode, context)}`,
            aql`COLLECT WITH COUNT INTO ${countVar}`,
            aql`return ${countVar}`
        );
    },

    MergeObjects(node: MergeObjectsQueryNode, context): AQLFragment {
        const objectList = node.objectNodes.map(node => processNode(node, context));
        const objectsFragment = aql.join(objectList, aql`, `);
        return aql`MERGE(${objectsFragment})`;
    },

    FirstOfList(node: FirstOfListQueryNode, context): AQLFragment {
        return aql`FIRST(${processNode(node.listNode, context)})`;
    },

    BinaryOperation(node: BinaryOperationQueryNode, context): AQLFragment {
        const lhs = processNode(node.lhs, context);
        const rhs = processNode(node.rhs, context);
        const op = getAQLOperator(node.operator);
        if (op) {
            return aql`(${lhs} ${op} ${rhs})`;
        }

        // TODO maybe use LIKE for fulltext indices
        switch (node.operator) {
            case BinaryOperator.CONTAINS:
                return aql`CONTAINS(${lhs}, ${rhs})`;
            case BinaryOperator.STARTS_WITH:
                return aql`(LEFT(${lhs}, LENGTH(${rhs})) == ${rhs})`;
            case BinaryOperator.ENDS_WITH:
                return aql`(RIGHT(${lhs}, LENGTH(${rhs})) == ${rhs})`;
            case BinaryOperator.APPEND:
                return aql`CONCAT(${lhs}, ${rhs})`;
            case BinaryOperator.PREPEND:
                return aql`CONCAT(${rhs}, ${lhs})`;
            default:
                throw new Error(`Unsupported binary operator: ${op}`);
        }
    },

    UnaryOperation(node: UnaryOperationQueryNode, context) {
        switch (node.operator) {
            case UnaryOperator.NOT:
                return aql`!(${processNode(node.valueNode, context)})`;
            case UnaryOperator.JSON_STRINGIFY:
                return aql`JSON_STRINGIFY(${processNode(node.valueNode, context)})`;
            default:
                throw new Error(`Unsupported unary operator: ${node.operator}`);
        }
    },

    Conditional(node: ConditionalQueryNode, context) {
        const cond = processNode(node.condition, context);
        const expr1 = processNode(node.expr1, context);
        const expr2 = processNode(node.expr2, context);
        return aql`(${cond} ? ${expr1} : ${expr2})`;
    },

    TypeCheck(node: TypeCheckQueryNode, context) {
        const value = processNode(node.valueNode, context);

        switch (node.type) {
            case BasicType.SCALAR:
                return aql`(IS_BOOL(${value}) || IS_NUMBER(${value}) || IS_STRING(${value}))`;
            case BasicType.LIST:
                return aql`IS_LIST(${value})`;
            case BasicType.OBJECT:
                return aql`IS_OBJECT(${value})`;
            case BasicType.NULL:
                return aql`IS_NULL(${value})`;
        }
    },

    Entities(node: EntitiesQueryNode, context): AQLFragment {
        return getCollectionForType(node.objectType, AccessType.READ, context);
    },

    FollowEdge(node: FollowEdgeQueryNode, context): AQLFragment {
        const tmpVar = aql.variable('node');
        // need to wrap this in a subquery because ANY is not possible as first token of an expression node in AQL
        return aqlExt.parenthesizeList(
            aql`FOR ${tmpVar}`,
            aql`IN ${getSimpleFollowEdgeFragment(node, context)}`,
            aql`FILTER ${tmpVar} != null`,
            aql`RETURN ${tmpVar}`
        );
    },

    CreateEntity(node: CreateEntityQueryNode, context): AQLFragment {
        return aqlExt.parenthesizeObject(
            aql`INSERT ${processNode(node.objectNode, context)} IN ${getCollectionForType(node.objectType, AccessType.WRITE, context)}`,
            aql`RETURN NEW._key`
        );
    },

    UpdateEntities(node: UpdateEntitiesQueryNode, context) {
        const newContext = context.introduceVariable(node.currentEntityVariable);
        const entityVar = newContext.getVariable(node.currentEntityVariable);
        return aqlExt.parenthesizeList(
            aql`FOR ${entityVar}`,
            aql`IN ${getCollectionForType(node.objectType, AccessType.READ, context)}`,
            aql`FILTER ${processNode(node.filterNode, newContext)}`,
            node.maxCount !== undefined ? aql`LIMIT ${node.maxCount}` : aql``,
            aql`UPDATE ${entityVar}`,
            aql`WITH ${processNode(new ObjectQueryNode(node.updates), newContext)}`,
            aql`IN ${getCollectionForType(node.objectType, AccessType.WRITE, context)}`,
            aql`OPTIONS { mergeObjects: false }`,
            aql`RETURN NEW._key`
        );
    },

    DeleteEntities(node: DeleteEntitiesQueryNode, context) {
        const newContext = context.introduceVariable(node.currentEntityVariable);
        const entityVar = newContext.getVariable(node.currentEntityVariable);
        return aqlExt.parenthesizeList(
            aql`FOR ${entityVar}`,
            aql`IN ${getCollectionForType(node.objectType, AccessType.READ, context)}`,
            aql`FILTER ${processNode(node.filterNode, newContext)}`,
            node.maxCount !== undefined ? aql`LIMIT ${node.maxCount}` : aql``,
            aql`REMOVE ${entityVar}`,
            aql`IN ${getCollectionForType(node.objectType, AccessType.WRITE, context)}`,
            aql`RETURN OLD`
        );
    },

    AddEdges(node: AddEdgesQueryNode, context) {
        const edgeVar = aql.variable('edge');
        return aqlExt.parenthesizeList(
            aql`FOR ${edgeVar}`,
            aql`IN [ ${aql.join(node.edges.map(edge => formatEdge(node.edgeType, edge, context)), aql`, `)} ]`,
            aql`UPSERT { _from: ${edgeVar}._from, _to: ${edgeVar}._to }`, // need to unpack avoid dynamic property names in UPSERT example filter
            aql`INSERT ${edgeVar}`,
            aql`UPDATE {}`,
            aql`IN ${getCollectionForEdge(node.edgeType, AccessType.WRITE, context)}`
        );
    },

    RemoveEdges(node: RemoveEdgesQueryNode, context) {
        const edgeVar = aql.variable('edge');
        return aqlExt.parenthesizeList(
            aql`FOR ${edgeVar}`,
            aql`IN ${getCollectionForEdge(node.edgeType, AccessType.READ, context)}`,
            aql`FILTER ${formatEdgeFilter(node.edgeType, node.edgeFilter, edgeVar, context)}`,
            aql`REMOVE ${edgeVar}`,
            aql`IN ${getCollectionForEdge(node.edgeType, AccessType.WRITE, context)}`
        );
    },

    SetEdge(node: SetEdgeQueryNode, context) {
        const edgeVar = aql.variable('edge');
        return aqlExt.parenthesizeList(
            aql`UPSERT ${formatEdge(node.edgeType, node.existingEdge, context)}`,
            aql`INSERT ${formatEdge(node.edgeType, node.newEdge, context)}`,
            aql`UPDATE ${formatEdge(node.edgeType, node.newEdge, context)}`,
            aql`IN ${getCollectionForEdge(node.edgeType, AccessType.WRITE, context)}`
        );
    }
};

/**
 * Gets an aql fragment that evaluates to a string of the format "collectionName/objectKey", given a query node that
 * evaluates to the "object id", which is, in arango terms, the _key.
 */
function getFullIDFromKeyNode(node: QueryNode, type: GraphQLObjectType, context: QueryContext): AQLFragment {
    // special handling to avoid concat if possible - do not alter the behavior
    if (node instanceof LiteralQueryNode && typeof node.value == 'string') {
        // just append the node to the literal key in JavaScript and bind it as a string
        return aql`${getCollectionNameForRootEntity(type) + '/' + node.value}`;
    }
    if (node instanceof RootEntityIDQueryNode) {
        // access the _id field. processNode(node) would access the _key field instead.
        return aql`${processNode(node.objectNode, context)}._id`;
    }

    // fall back to general case
    return aql`CONCAT(${getCollectionNameForRootEntity(type) + '/'}, ${processNode(node, context)})`;
}

function formatEdge(edgeType: EdgeType, edge: PartialEdgeIdentifier|EdgeIdentifier, context: QueryContext): AQLFragment {
    const conditions = [];
    if (edge.fromIDNode) {
        conditions.push(aql`_from: ${getFullIDFromKeyNode(edge.fromIDNode, edgeType.fromType, context)}`);
    }
    if (edge.toIDNode) {
        conditions.push(aql`_to: ${getFullIDFromKeyNode(edge.toIDNode, edgeType.toType, context)}`);
    }

    return aql`{${aql.join(conditions, aql`, `)}}`;
}

function formatEdgeFilter(edgeType: EdgeType, edge: EdgeFilter, edgeFragment: AQLFragment, context: QueryContext) {
    function makeList(ids: QueryNode[], type: GraphQLObjectType) {
        return aql`[${aql.join(ids.map(node => getFullIDFromKeyNode(node, type, context)), aql`, `)}]`;
    }

    const conditions = [];
    if (edge.fromIDNodes) {
        conditions.push(aql`${edgeFragment}._from IN ${makeList(edge.fromIDNodes, edgeType.fromType)}`);
    }
    if (edge.toIDNodes) {
        conditions.push(aql`${edgeFragment}._to IN ${makeList(edge.toIDNodes, edgeType.toType)}`);
    }

    return aql.join(conditions, aql` && `);
}

function getAQLOperator(op: BinaryOperator): AQLFragment|undefined {
    switch (op) {
        case BinaryOperator.AND:
            return aql`&&`;
        case BinaryOperator.OR:
            return aql`||`;
        case BinaryOperator.EQUAL:
            return aql`==`;
        case BinaryOperator.UNEQUAL:
            return aql`!=`;
        case BinaryOperator.LESS_THAN:
            return aql`<`;
        case BinaryOperator.LESS_THAN_OR_EQUAL:
            return aql`<=`;
        case BinaryOperator.GREATER_THAN:
            return aql`>`;
        case BinaryOperator.GREATER_THAN_OR_EQUAL:
            return aql`>=`;
        case BinaryOperator.IN:
            return aql`IN`;
        case BinaryOperator.ADD:
            return aql`+`;
        case BinaryOperator.SUBTRACT:
            return aql`-`;
        case BinaryOperator.MULTIPLY:
            return aql`*`;
        case BinaryOperator.DIVIDE:
            return aql`/`;
        case BinaryOperator.MODULO:
            return aql`%`;
        default:
            return undefined;
    }
}

function generateSortAQL(orderBy: OrderSpecification, context: QueryContext): AQLFragment {
    if (orderBy.isUnordered()) {
        return aql``;
    }

    function dirAQL(dir: OrderDirection) {
        if (dir == OrderDirection.DESCENDING) {
            return aql` DESC`;
        }
        return aql``;
    }

    const clauses = orderBy.clauses.map(cl => aql`(${processNode(cl.valueNode, context)}) ${dirAQL(cl.direction)}`);

    return aql`SORT ${aql.join(clauses, aql`, `)}`;
}

const processorMap: {[name: string]: NodeProcessor<any>} = {};
for (const processorName in processors) {
    processorMap[processorName + 'QueryNode'] = processors[processorName];
}

function processNode(node: QueryNode, context: QueryContext): AQLFragment {
    const type = node.constructor.name;
    if (!(type in processorMap)) {
        throw new Error(`Unsupported query type: ${type}`);
    }
    return processorMap[type](node, context);
}

// TODO I think AQLCompoundQuery (AQL transaction node) should not be the exported type
// we should rather export AQLExecutableQuery[] (as AQL transaction) directly.
export function getAQLQuery(node: QueryNode): AQLCompoundQuery {
    return createAQLCompoundQuery(node, aql.queryResultVariable('result'), undefined, new QueryContext());
}

function getCollectionForType(type: GraphQLNamedType, accessType: AccessType, context: QueryContext) {
    const name = getCollectionNameForRootEntity(type);
    context.addCollectionAccess(name, accessType);
    return aql.collection(name);
}

function getCollectionForEdge(edgeType: EdgeType, accessType: AccessType, context: QueryContext) {
    const name = getCollectionNameForEdge(edgeType);
    context.addCollectionAccess(name, accessType);
    return aql.collection(name);
}

/**
 * Processes a FollowEdgeQueryNode into a fragment to be used within `IN ...` (as opposed to be used in a general
 * expression context)
 */
function getSimpleFollowEdgeFragment(node: FollowEdgeQueryNode, context: QueryContext): AQLFragment {
    switch (node.sourceFieldSide) {
        case RelationFieldEdgeSide.FROM_SIDE:
            return aql`OUTBOUND ${processNode(node.sourceEntityNode, context)} ${getCollectionForEdge(node.edgeType, AccessType.READ, context)}`;
        case RelationFieldEdgeSide.TO_SIDE:
            return aql`INBOUND ${processNode(node.sourceEntityNode, context)} ${getCollectionForEdge(node.edgeType, AccessType.READ, context)}`;
    }

}
