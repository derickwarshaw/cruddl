import { getPermissionDescriptor } from '../permission-descriptors-in-schema';
import { AccessOperation, AuthContext, AUTHORIZATION_ERROR_NAME } from '../auth-basics';
import {
    AffectedFieldInfoQueryNode, FieldQueryNode, QueryNode, RuntimeErrorQueryNode, SetFieldQueryNode
} from '../../query/definition';
import { PermissionResult } from '../permission-descriptors';
import { ACCESS_GROUP_FIELD } from '../../schema/schema-defaults';
import { isRootEntityType } from '../../schema/schema-utils';

export function transformAffectedFieldInfoQueryNode(node: AffectedFieldInfoQueryNode, authContext: AuthContext): QueryNode {
    const permissionDescriptor = getPermissionDescriptor(node.objectType, node.field);
    const access = permissionDescriptor.canAccess(authContext, AccessOperation.WRITE);
    switch (access) {
        case PermissionResult.DENIED:
            return new RuntimeErrorQueryNode(`${AUTHORIZATION_ERROR_NAME}: Not authorized to set ${node.objectType.name}.${node.field.name}`);
        case PermissionResult.CONDITIONAL:
            throw new Error(`Conditional permission profiles are currently not supported on fields, but used in ${node.objectType.name}.${node.field.name}`);
    }

    // check if this is setting the accessGroup
    if (node.field.name == ACCESS_GROUP_FIELD && isRootEntityType(node.objectType)) {
        const permissionDescriptor = getPermissionDescriptor(node.objectType);
        // TODO add PreExecQuery to check the new value
    }

    return node;
}
