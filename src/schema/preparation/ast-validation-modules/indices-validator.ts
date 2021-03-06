import {ASTValidator} from "../ast-validator";
import {
    DocumentNode, EnumTypeDefinitionNode, GraphQLBoolean, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLString, Location,
    ObjectTypeDefinitionNode, StringValueNode, ValueNode
} from 'graphql';
import {ValidationMessage} from "../validation-message";
import {
    findDirectiveWithName, getChildEntityTypes, getEntityExtensionTypes, getNamedTypeDefinitionAST, getNodeByName,
    getRootEntityTypes, getTypeNameIgnoringNonNullAndList, getValueObjectTypes
} from "../../schema-utils";
import {
    CHILD_ENTITY_DIRECTIVE, ENTITY_EXTENSION_DIRECTIVE, INDEX_DIRECTIVE, INDEX_FIELDS_FIELD, INDICES_ARG,
    ROOT_ENTITY_DIRECTIVE, UNIQUE_DIRECTIVE, VALUE_OBJECT_DIRECTIVE
} from "../../schema-defaults";
import {ENUM_TYPE_DEFINITION, LIST, OBJECT, OBJECT_FIELD, OBJECT_TYPE_DEFINITION, STRING} from "../../../graphql/kinds";

export const VALIDATION_ERROR_INDICES_MISSING_FIELDS = 'Missing argument fields on index definition';
export const VALIDATION_ERROR_INDICES_INVALID_PATH_BAD_SYNTAX = 'A path should be field names separated by dots';
export const VALIDATION_ERROR_INDICES_INVALID_FIELDS_ARGUMENT = 'Field "fields" must be a non-empty list of field names from the current root entity.';
export const VALIDATION_ERROR_INDICES_DUPLICATE_INDEX_DEFINITION = 'Duplicate index definition.';
export const VALIDATION_ERROR_INDICES_INVALID_PATH_NON_SCALAR_END = 'Indices can only be defined on scalar or enum fields. Specify a dot-separated field path to create an index on an embedded object.';
export const VALIDATION_ERROR_INDICES_ONLY_ON_ROOT_ENTITIES = "Indices are only allowed in root entity fields. You can add indices to fields of embedded objects with @rootEntities(indices: [...]).";

export class IndicesValidator implements ASTValidator {

    validate(ast: DocumentNode): ValidationMessage[] {
        const validationMessages: ValidationMessage[] = [];
        getRootEntityTypes(ast).forEach(rootEntity => {
            const rootEntityDirective = getNodeByName(rootEntity.directives, ROOT_ENTITY_DIRECTIVE)!;
            const indicesArg = getNodeByName(rootEntityDirective.arguments, INDICES_ARG);
            if (!indicesArg || indicesArg.value.kind !== LIST) {
                return;
            }
            const indicesMap = new Map<String, ValueNode>();
            indicesArg.value.values.forEach(indexDefinition => {
                if (indexDefinition.kind !== OBJECT) {
                    return;
                }
                const fieldsField = getNodeByName(indexDefinition.fields, INDEX_FIELDS_FIELD);
                if (!fieldsField || fieldsField.kind !== OBJECT_FIELD) {
                    validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_MISSING_FIELDS, {}, indexDefinition.loc));
                    return;
                }
                if (fieldsField.value.kind !== LIST || fieldsField.value.values.length === 0) {
                    validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_INVALID_FIELDS_ARGUMENT, {}, fieldsField.loc ? fieldsField.loc : indexDefinition.loc));
                    return;
                }
                const indexFields = fieldsField.value.values.map(field => {
                    if (field.kind !== STRING) {
                        validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_INVALID_FIELDS_ARGUMENT, {}, field.loc ? field.loc : indexDefinition.loc));
                        return undefined;
                    }
                    return field.value;
                });
                if (indexFields.some(field => !field)) {
                    return;
                }
                const indexKey = indexFields.join('|');
                const storedIndexDefinition = indicesMap.get(indexKey);
                if (storedIndexDefinition) {
                    validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_DUPLICATE_INDEX_DEFINITION, {}, indexDefinition.loc));
                    validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_DUPLICATE_INDEX_DEFINITION, {}, storedIndexDefinition.loc));
                } else {
                    indicesMap.set(indexKey, indexDefinition);
                }
                fieldsField.value.values.forEach(indexField => checkASTPath((indexField as StringValueNode).value, rootEntity, ast, validationMessages, indexField.loc ? indexField.loc : indexDefinition.loc))
            });
        });
        [...getChildEntityTypes(ast), ...getEntityExtensionTypes(ast), ...getValueObjectTypes(ast)].forEach(nonRootEntityType => {
            nonRootEntityType.fields.forEach(field => {
                const index = findDirectiveWithName(field, INDEX_DIRECTIVE);
                const unique = findDirectiveWithName(field, UNIQUE_DIRECTIVE);
                if (index) {
                    validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_ONLY_ON_ROOT_ENTITIES, { type: nonRootEntityType.name.value, field: field.name.value }, index.loc));
                }
                if (unique) {
                    validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_ONLY_ON_ROOT_ENTITIES, { type: nonRootEntityType.name.value, field: field.name.value }, unique.loc));
                }
            })
        });
        return validationMessages;
    }

}

// check if a path is valid starting from a given object type
function checkASTPath(path: string, type: ObjectTypeDefinitionNode, ast: DocumentNode, validationMessages: ValidationMessage[], loc: Location|undefined) {
    if (!path.match(/^([\w]+\.)*[\w]+$/)) {
        validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_INVALID_PATH_BAD_SYNTAX, {}, loc));
        return;
    }
    const requiredFieldName = path.split(/\.([\w]*)/)[0];
    const remainingPath = path.split(/\.([\w]*)/)[1];
    const fieldNode = getNodeByName(type.fields, requiredFieldName);
    if (!fieldNode) {
        validationMessages.push(ValidationMessage.error(`Type "${type.name.value}" does not have a field "${requiredFieldName}"`, { field: requiredFieldName, type: type.name.value }, loc));
        return;
    }
    const fieldTypeName = getTypeNameIgnoringNonNullAndList(fieldNode.type);
    const fieldType = getNamedTypeDefinitionAST(ast, fieldTypeName);
    if (remainingPath) {
        if (fieldType.kind !== OBJECT_TYPE_DEFINITION) {
            validationMessages.push(ValidationMessage.error(`Field "${requiredFieldName}" is not an object`, { field: requiredFieldName, type: type.name.value }, loc));
            return;
        }
        if (!getNodeByName(fieldType.directives, VALUE_OBJECT_DIRECTIVE)
            && !getNodeByName(fieldType.directives, CHILD_ENTITY_DIRECTIVE)
            && !getNodeByName(fieldType.directives, ENTITY_EXTENSION_DIRECTIVE)) {
            validationMessages.push(ValidationMessage.error(`Field "${requiredFieldName}" resolves to a root entity, but indices can not cross root entity boundaries`, { field: requiredFieldName, type: type.name.value }, loc));
            return;
        }
        checkASTPath(remainingPath, fieldType, ast, validationMessages, loc);
    } else {
        if (!getAllowedPathEndIndexTypes(ast).includes(fieldTypeName)) {
            validationMessages.push(ValidationMessage.error(VALIDATION_ERROR_INDICES_INVALID_PATH_NON_SCALAR_END, { field: requiredFieldName, type: type.name.value }, loc));
            return;
        }
    }
}

function getAllowedPathEndIndexTypes(ast: DocumentNode) {
    const enumTypeNames = ast.definitions.filter(def => def.kind === ENUM_TYPE_DEFINITION).map(enumType => (enumType as EnumTypeDefinitionNode).name.value);
    return [GraphQLString.name, GraphQLInt.name, GraphQLFloat.name, GraphQLID.name, GraphQLBoolean.name, ...enumTypeNames];
}

