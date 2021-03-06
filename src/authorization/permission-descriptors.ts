import {
    BinaryOperationQueryNode, BinaryOperator, ConstBoolQueryNode, FieldQueryNode, LiteralQueryNode, QueryNode,
    UnknownValueQueryNode
} from '../query/definition';
import { simplifyBooleans } from '../query/query-tree-utils';
import { Permission, PermissionProfile } from './permission-profile';
import { flatMap } from 'lodash';
import { AccessOperation, AuthContext } from './auth-basics';
import { GraphQLField, GraphQLObjectType } from 'graphql';
import { ACCESS_GROUP_FIELD } from '../schema/schema-defaults';

export enum ConditionExplanationContext {
    BEFORE_WRITE,
    SET
}

/**
 * Determines whether a user can access information, possibly dependent on the instance containing the information
 */
export abstract class PermissionDescriptor {
    /**
     * Gets the condition which determines if a user has access
     * @param authContext
     * @param operation
     * @param instanceNode a QueryNode which evaluates to the instance
     * @returns a QueryNode that evaluates to TRUE if the user has access or FALSE if they don't
     */
    abstract getAccessCondition(authContext: AuthContext, operation: AccessOperation, instanceNode: QueryNode): QueryNode;

    /**
     * Determines if a user has access or if it depends on the instance
     */
    canAccess(authContext: AuthContext, operation: AccessOperation): PermissionResult {
        const condition = simplifyBooleans(this.getAccessCondition(authContext, operation, new UnknownValueQueryNode()));
        if (condition instanceof ConstBoolQueryNode) {
            return condition.value ? PermissionResult.GRANTED : PermissionResult.DENIED;
        }
        return PermissionResult.CONDITIONAL;
    }

    /**
     * Gets a human-readable explanation fragment that explains why some instance could not be accessed
     */
    getExplanationForCondition(authContext: AuthContext, operation: AccessOperation, context: ConditionExplanationContext): string|undefined {
        return undefined;
    }
}

export enum PermissionResult {
    /**
     * Access is granted for all instances
     */
    GRANTED,

    /**
     * Access may be granted or denied, depending on the instance's accessGroup
     */
    CONDITIONAL,

    /**
     * Access is denied for all instances
     */
    DENIED
}

export class AlwaysGrantPermissionDescriptor extends PermissionDescriptor {
    getAccessCondition(authContext: AuthContext, operation: AccessOperation): QueryNode {
        return ConstBoolQueryNode.TRUE;
    }

    canAccess(authContext: AuthContext, operation: AccessOperation): PermissionResult {
        return PermissionResult.GRANTED;
    }

    static INSTANCE = new AlwaysGrantPermissionDescriptor();
}

export class ConjunctivePermissionDescriptor extends PermissionDescriptor {
    constructor(public readonly lhs: PermissionDescriptor, public readonly rhs: PermissionDescriptor) {
        super();
    }

    getAccessCondition(authContext: AuthContext, operation: AccessOperation): QueryNode {
        const unknownAccessGroup = new UnknownValueQueryNode();
        return simplifyBooleans(new BinaryOperationQueryNode(
            this.lhs.getAccessCondition(authContext, operation, unknownAccessGroup),
            BinaryOperator.AND,
            this.rhs.getAccessCondition(authContext, operation, unknownAccessGroup)
        ));
    }
}

export class StaticPermissionDescriptor extends PermissionDescriptor {
    private allReadRoles: string[];

    constructor(public readonly readRoles: string[], public readonly readWriteRoles: string[]) {
        super();
        this.allReadRoles = [...readRoles, ...readWriteRoles];
    }

    getAccessCondition(authContext: AuthContext, operation: AccessOperation): QueryNode {
        let roles: string[] = [];
        switch (operation) {
            case AccessOperation.READ:
                roles = this.allReadRoles;
                break;
            case AccessOperation.WRITE:
                roles = this.readWriteRoles;
        }
        const allowed = roles.some(allowedRole => authContext.authRoles.includes(allowedRole));
        return new ConstBoolQueryNode(allowed);
    }
}

export class ProfileBasedPermissionDescriptor extends PermissionDescriptor {
    private accessGroupField: GraphQLField<any, any>|undefined;

    constructor(private profile: PermissionProfile, private readonly objectType: GraphQLObjectType) {
        super();
        this.accessGroupField = objectType.getFields()[ACCESS_GROUP_FIELD];
    }

    getAccessCondition(authContext: AuthContext, operation: AccessOperation, instanceNode: QueryNode): QueryNode {
        const applicablePermissions = this.getApplicablePermissions(authContext, operation);

        if (!applicablePermissions.length) {
            return ConstBoolQueryNode.FALSE;
        }

        if (applicablePermissions.some(permission => !permission.restrictToAccessGroups)) {
            return ConstBoolQueryNode.TRUE;
        }

        const allowedAccessGroups = this.getAllowedAccessGroups(applicablePermissions);
        if (!this.accessGroupField) {
            throw new Error(`Using accessGroup-restricted permission profile on type ${this.objectType.name} which does not have an accessGroup field`);
        }
        const accessGroupNode = new FieldQueryNode(instanceNode, this.accessGroupField, this.objectType);
        return new BinaryOperationQueryNode(accessGroupNode, BinaryOperator.IN, new LiteralQueryNode(allowedAccessGroups));
    }

    private getApplicablePermissions(authContext: AuthContext, operation: AccessOperation): Permission[] {
        return this.profile.permissions.filter(permission => permission.allowsOperation(operation) && permission.appliesToAuthContext(authContext));
    }

    private getAllowedAccessGroups(applicablePermissions: Permission[]) {
        return flatMap(applicablePermissions, permission => permission.restrictToAccessGroups!);
    }

    getExplanationForCondition(authContext: AuthContext, operation: AccessOperation, context: ConditionExplanationContext): string|undefined {
        const applicablePermissions = this.getApplicablePermissions(authContext, operation);

        // if we don't have accessGroup restrictions, there is nothing to explain
        if (applicablePermissions.every(permission => !permission.restrictToAccessGroups)) {
            return undefined;
        }

        const allowedAccessGroups = this.getAllowedAccessGroups(applicablePermissions);
        const prefix = this.getExplanationPrefix(context);
        return `${prefix}${allowedAccessGroups.join(', ')})`;
    }

    getExplanationPrefix(context: ConditionExplanationContext): string {
        const accessGroupFieldName = this.accessGroupField ? this.accessGroupField.name : this.accessGroupField;
        switch (context) {
            case ConditionExplanationContext.BEFORE_WRITE:
                return `${this.objectType.name} objects with this access group (allowed access groups: `;
            case ConditionExplanationContext.SET:
                return `set ${this.objectType}.${accessGroupFieldName} to this value (allowed values: `;
        }
    }
}
