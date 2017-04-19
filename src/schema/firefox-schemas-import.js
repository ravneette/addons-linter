import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import commentJson from 'comment-json';
import merge from 'deepmerge';
import request from 'request';
import tar from 'tar';

const FLAG_PATTERN_REGEX = /^\(\?[im]*\)(.*)/;
const UNRECOGNIZED_PROPERTY_REFS = [
  'UnrecognizedProperty',
  'manifest#/types/UnrecognizedProperty',
];

const schemaRegexes = [
  new RegExp('browser/components/extensions/schemas/.*\.json'),
  new RegExp('toolkit/components/extensions/schemas/.*\.json'),
];

export const refMap = {
  ExtensionURL: 'manifest#/types/ExtensionURL',
  HttpURL: 'manifest#/types/HttpURL',
};

// Reference some functions on inner so they can be stubbed in tests.
export const inner = {};

// Consider moving this to a Set if you add more schema namespaces.
// Some schemas aren't actually exposed to add-ons, or are for internal
// use in Firefox only. We shouldn't import these schemas.
export const ignoredSchemas = ['omnibox_internal'];

function stripFlagsFromPattern(value) {
  // TODO: Fix these patterns and remove this code.
  const matches = FLAG_PATTERN_REGEX.exec(value);
  if (matches) {
    return matches[1];
  }
  return value;
}

/*
 * Convert the absence of `optional` or `optional: false` to an array of
 * required properties at the same level of the properties (more processing
 * is done in rewriteValue).
 */
export function rewriteOptionalToRequired(schema) {
  const required = [];
  const withoutOptional = Object.keys(schema).reduce((obj, key) => {
    const value = schema[key];
    if (!Array.isArray(value) && typeof value === 'object') {
      const { optional, ...rest } = value;
      if (!optional) {
        required.push(key);
      }
      return { ...obj, [key]: rest };
    }
    return { ...obj, [key]: value };
  }, {});
  return { ...withoutOptional, required };
}

function isUnrecognizedProperty(value) {
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return keys.length === 1
      && '$ref' in value
      && UNRECOGNIZED_PROPERTY_REFS.includes(value.$ref);
  }
  return false;
}

export function rewriteValue(key, value) {
  if (Array.isArray(value)) {
    return value.map((val) => rewriteValue(key, val));
  } else if (key === 'additionalProperties' &&
      isUnrecognizedProperty(value)) {
    return undefined;
  } else if (typeof value === 'object') {
    if ('$ref' in value && Object.keys(value).length > 1) {
      const { $ref, ...rest } = value;
      if (Object.keys(rest).length === 1 && 'optional' in rest) {
        return {
          $ref: rewriteValue('$ref', $ref),
          ...rest,
        };
      }
      return {
        allOf: [
          { $ref: rewriteValue('$ref', $ref) },
          rewriteValue(key, rest),
        ],
      };
    }
    const rewritten = inner.rewriteObject(value);
    if ('properties' in rewritten) {
      const { required, ...properties } = rewriteOptionalToRequired(
        rewritten.properties);
      if (required.length > 0) {
        return { ...rewritten, properties, required };
      }
      return { ...rewritten, properties };
    }
    return rewritten;
  } else if (key === '$ref') {
    if (value.includes('#/types')) {
      return value;
    } else if (value in refMap) {
      return refMap[value];
    }
    let path = value;
    let schemaId = '';
    if (value.includes('.')) {
      [schemaId, path] = value.split('.', 2);
    }
    return `${schemaId}#/types/${path}`;
  } else if (key === 'type' && value === 'any') {
    return undefined;
  } else if (key === 'id') {
    return undefined;
  } else if (key === 'pattern') {
    return stripFlagsFromPattern(value);
  }
  return value;
}

export function rewriteKey(key) {
  if (key === 'choices') {
    return 'anyOf';
  }
  return key;
}

inner.rewriteObject = (schema) => {
  return Object.keys(schema).reduce((obj, key) => {
    const value = rewriteValue(key, schema[key]);
    if (value === undefined) {
      return obj;
    }
    return { ...obj, [rewriteKey(key)]: value };
  }, {});
};

inner.mapExtendToRef = (schemas) => {
  const updatedSchemas = { ...schemas };
  Object.keys(updatedSchemas).forEach((id) => {
    const { schema } = updatedSchemas[id];
    Object.keys(schema.refs).forEach((ref) => {
      const { namespace, type } = schema.refs[ref];
      const extendSchema = updatedSchemas[namespace].schema;
      const extendType = extendSchema.types[type];
      let updatedType;
      if ('anyOf' in extendType) {
        updatedType = {
          ...extendType,
          anyOf: [...extendType.anyOf, { $ref: ref }],
        };
      } else if (!('allOf' in extendType)) {
        updatedType = { allOf: [extendType, { $ref: ref }] };
      } else {
        updatedType = {
          ...extendType,
          allOf: [...extendType.allOf, { $ref: ref }],
        };
      }
      if (updatedType) {
        updatedSchemas[namespace] = {
          ...updatedSchemas[namespace],
          schema: {
            ...extendSchema,
            types: {
              ...extendSchema.types,
              [type]: updatedType,
            },
          },
        };
      }
    });
  });
  return updatedSchemas;
};

inner.updateWithAddonsLinterData = (firefoxSchemas, ourSchemas) => {
  const schemas = { ...firefoxSchemas };
  Object.keys(ourSchemas).forEach((namespace) => {
    const firefoxSchema = firefoxSchemas[namespace];
    const ourSchema = ourSchemas[namespace];
    schemas[namespace] = {
      ...firefoxSchema,
      schema: merge(firefoxSchema.schema, ourSchema),
    };
  });
  return schemas;
};

export function loadTypes(types = []) {
  // Convert the array of types to an object.
  return types.reduce((obj, type) => ({
    ...obj,
    [type.id]: type,
  }), {});
}

function rewriteExtendRefs(definition, namespace, types) {
  if (Array.isArray(definition)) {
    return definition.map(
      (value) => rewriteExtendRefs(value, namespace, types));
  } else if (typeof definition === 'object') {
    return Object.keys(definition).reduce((obj, key) => {
      const value = definition[key];
      if (key === '$ref') {
        if (!value.includes('.') && !(value in types)) {
          return { ...obj, [key]: `${namespace}#/types/${value}` };
        }
      }
      return { ...obj, [key]: rewriteExtendRefs(value, namespace, types) };
    }, {});
  }
  return definition;
}

export function rewriteExtend(schemas, schemaId) {
  const definitions = {};
  const refs = {};
  const types = {};
  schemas.forEach((extendSchema) => {
    const extendId = extendSchema.namespace;
    const extendDefinitions = {};
    const extendTypes = {};
    (extendSchema.types || []).forEach((type) => {
      const { $extend, id, ...rest } = type;
      if ($extend) {
        // Move the $extend into definitions.
        extendDefinitions[$extend] = rest;
        // Remember the location of this file so we can $ref it later.
        refs[`${schemaId}#/definitions/${$extend}`] = {
          namespace: extendId,
          type: $extend,
        };
      } else if (id) {
        // Move this type into types.
        extendTypes[id] = rest;
        types[id] = rest;
      } else {
        throw new Error('cannot handle extend, $extend or id is required');
      }
    });
    Object.keys(extendDefinitions).forEach((id) => {
      // Update $refs to point to the right namespace.
      const definition = extendDefinitions[id];
      definitions[id] = rewriteExtendRefs(definition, extendId, extendTypes);
    });
  });
  return { definitions, refs, types };
}

export function filterSchemas(schemas) {
  return schemas.filter((schema) => {
    return !ignoredSchemas.includes(schema.namespace);
  });
}

/**
 * Merge multiple schemas into one if they are properties of each other.
 *
 * Example:
 *
 *  [{ namespace: "privacy", permissions: ["privacy"] },
 *   { namespace: "privacy.network", properties: { networkPredictionEnabled: {} } }]
 *
 *  becomes
 *
 *  [{ namespace: "privacy",
 *     permissions: ["privacy"],
 *     properties: {
 *       network: {
 *         properties: {
 *           networkPredictionEnabled: {}
 *  }}}}]
 */
export function foldSchemas(schemas) {
  // Map the schemas by prefix.
  const schemasByPrefix = {};
  schemas.forEach((schema) => {
    const [prefix, property, more] = schema.namespace.split('.', 3);
    if (more) {
      throw new Error('namespace may only have one level of nesting');
    }
    if (!(prefix in schemasByPrefix)) {
      schemasByPrefix[prefix] = {};
    }
    let namespace = property ? property : 'baseNamespace';
    if (schemasByPrefix[prefix][namespace]) {
      throw new Error('matching namespaces are not allowed');
    } else {
      schemasByPrefix[prefix][namespace] = schema;
    }
  });
  // If there aren't any matching prefixes then there's no folding to do.
  const hasMatchingPrefixes = Object.keys(schemasByPrefix).some((prefix) => {
    const prefixedSchemas = schemasByPrefix[prefix];
    // Continue if there are multiple properties (baseNamespace and something
    // else) or there is one property that isn't baseNamespace.
    return Object.keys(prefixedSchemas).length > 1
      || !('baseNamespace' in prefixedSchemas);
  });
  if (!hasMatchingPrefixes) {
    return schemas;
  }

  // There is folding to do, join the matching schemas.
  const foldedSchemas = [];

  // The order of the schemas will be maintained since they were inserted in
  // the order of schemas.
  Object.keys(schemasByPrefix).forEach((namespace) => {
    const { baseNamespace = {}, ...nestedSchemas } = schemasByPrefix[namespace];
    foldedSchemas.push(baseNamespace);
    // Ensure the base namespace is set.
    baseNamespace.namespace = namespace;
    if (Object.keys(nestedSchemas).length > 0 && !baseNamespace.properties) {
      baseNamespace.properties = {};
    }
    Object.keys(nestedSchemas).forEach((property) => {
      const schema = nestedSchemas[property];
      delete schema.namespace;
      if (schema.types) {
        baseNamespace.types = baseNamespace.types || [];
        baseNamespace.types = baseNamespace.types.concat(schema.types);
        delete schema.types;
      }
      baseNamespace.properties[property] = schema;
    });
  });

  return foldedSchemas;
}

inner.normalizeSchema = (schemas, file) => {
  const filteredSchemas = foldSchemas(filterSchemas(schemas));
  let extendSchemas;
  let primarySchema;

  if (filteredSchemas.length === 1) {
    // If there is only a manifest namespace then this just extends the manifest.
    if (filteredSchemas[0].namespace === 'manifest'
        && file !== 'manifest.json') {
      primarySchema = {
        namespace: file.slice(0, file.indexOf('.')),
      };
      extendSchemas = [filteredSchemas[0]];
    } else {
      primarySchema = filteredSchemas[0];
      extendSchemas = [];
    }
  } else {
    extendSchemas = filteredSchemas.slice(0, filteredSchemas.length - 1);
    primarySchema = filteredSchemas[filteredSchemas.length - 1];
  }
  const { namespace, types, ...rest } = primarySchema;
  const { types: extendTypes, ...extendRest } = rewriteExtend(
      extendSchemas, namespace);
  const updatedTypes = { ...loadTypes(types), ...extendTypes };
  return {
    ...rest,
    ...extendRest,
    id: namespace,
    types: updatedTypes,
  };
};

inner.loadSchema = (schema, file) => {
  const { id, ...rest } = inner.normalizeSchema(schema, file);
  const newSchema = { id, ...inner.rewriteObject(rest) };
  if (id === 'manifest') {
    newSchema.$ref = '#/types/WebExtensionManifest';
  }
  return newSchema;
};

inner.mergeSchemas = (schemaLists) => {
  const schemas = {};
  Object.keys(schemaLists).forEach((namespace) => {
    const namespaceSchemas = schemaLists[namespace];
    if (namespaceSchemas.length === 1) {
      schemas[namespace] = namespaceSchemas[0];
    } else {
      const file = `${namespace}.json`;
      const merged = namespaceSchemas.reduce((memo, { schema }) => {
        return merge(memo, schema);
      }, {});
      schemas[namespace] = { file, schema: merged };
    }
  });
  return schemas;
};

export function processSchemas(schemas) {
  const schemaListsByNamespace = {};
  schemas.forEach(({ file, schema }) => {
    // Convert the Firefox schema to more standard JSON schema.
    const loadedSchema = inner.loadSchema(schema, file);
    const { id } = loadedSchema;
    if (!(id in schemaListsByNamespace)) {
      schemaListsByNamespace[id] = [];
    }
    schemaListsByNamespace[id].push({ file, schema: loadedSchema });
  });
  const mergedSchemasByNamespace = inner.mergeSchemas(schemaListsByNamespace);
  // Now that everything is loaded, we can finish mapping the non-standard
  // $extend to $ref.
  return inner.mapExtendToRef(mergedSchemasByNamespace);
}

const SKIP_SCHEMAS = [
  'native_host_manifest.json',
];

function readSchema(basePath, file) {
  return commentJson.parse(
    fs.readFileSync(path.join(basePath, file), 'utf-8'),
    null, // reviver
    true, // remove_comments
  );
}

function writeSchema(basePath, file, schema) {
  fs.writeFileSync(
    path.join(basePath, file),
    `${JSON.stringify(schema, undefined, 2)}\n`);
}

function schemaFiles(basePath) {
  return fs.readdirSync(basePath);
}

function writeSchemasToFile(basePath, importedPath, loadedSchemas) {
  // Write out the schemas.
  Object.keys(loadedSchemas).forEach((id) => {
    const { file, schema } = loadedSchemas[id];
    writeSchema(importedPath, file, schema);
  });
}

function loadSchemasFromFile(basePath) {
  const schemas = [];
  // Read the schemas into loadedSchemas.
  schemaFiles(basePath).forEach((file) => {
    if (SKIP_SCHEMAS.includes(file)) {
      return;
    }
    const schema = readSchema(basePath, file);
    schemas.push({ file, schema });
  });
  return schemas;
}

export function importSchemas(firefoxPath, ourPath, importedPath) {
  const rawSchemas = loadSchemasFromFile(firefoxPath);
  const ourSchemas = readSchema(ourPath, 'manifest.json');
  const processedSchemas = processSchemas(rawSchemas);
  const updatedSchemas = inner.updateWithAddonsLinterData(
    processedSchemas, ourSchemas);
  writeSchemasToFile(firefoxPath, importedPath, updatedSchemas);
}

function downloadUrl(version) {
  return `https://hg.mozilla.org/mozilla-central/archive/FIREFOX_AURORA_${version}_BASE.tar.gz`;
}

inner.isBrowserSchema = (path) => {
  return schemaRegexes.some((re) => re.test(path));
};

export function fetchSchemas({ inputPath, outputPath, version }) {
  return new Promise((resolve) => {
    let tarball;
    if (inputPath) {
      tarball = fs.createReadStream(inputPath);
    } else if (version) {
      tarball = request.get(downloadUrl(version));
    }
    tarball
      .pipe(zlib.createGunzip())
      // eslint-disable-next-line new-cap
      .pipe(tar.Parse())
      .on('entry', (entry) => {
        if (inner.isBrowserSchema(entry.path)) {
          const filePath = path.join(outputPath, path.basename(entry.path));
          entry.pipe(fs.createWriteStream(filePath));
        }
      })
      .on('end', () => {
        resolve();
      });
  });
}
