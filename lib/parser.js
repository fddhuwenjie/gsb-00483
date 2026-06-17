const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function resolveRef(schema, ref, rootSchema) {
  if (!ref.startsWith('#/')) {
    return ref;
  }
  const parts = ref.slice(2).split('/');
  let current = rootSchema;
  for (const part of parts) {
    if (current && current[part] !== undefined) {
      current = current[part];
    } else {
      return schema;
    }
  }
  return current;
}

function resolveAllRefs(obj, rootSchema) {
  if (obj === null || obj === undefined) return obj;
  
  if (typeof obj === 'object') {
    if (obj.$ref) {
      const resolved = resolveRef(obj, obj.$ref, rootSchema);
      return resolveAllRefs(resolved, rootSchema);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => resolveAllRefs(item, rootSchema));
    }
    
    const result = {};
    for (const key in obj) {
      result[key] = resolveAllRefs(obj[key], rootSchema);
    }
    return result;
  }
  
  return obj;
}

function parseOpenAPI(filePath) {
  const absolutePath = path.resolve(filePath);
  const fileContent = fs.readFileSync(absolutePath, 'utf8');
  
  let openapi;
  try {
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      openapi = yaml.load(fileContent);
    } else {
      openapi = JSON.parse(fileContent);
    }
  } catch (error) {
    throw new Error(`Failed to parse OpenAPI file: ${error.message}`);
  }
  
  if (!openapi.openapi || !openapi.openapi.startsWith('3.')) {
    throw new Error('Only OpenAPI 3.0+ is supported');
  }
  
  const rootSchema = openapi;
  const endpoints = [];
  
  for (const pathKey in openapi.paths) {
    const pathItem = openapi.paths[pathKey];
    
    const pathParameters = pathItem.parameters || [];
    
    const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
    for (const method of methods) {
      if (pathItem[method]) {
        const operation = pathItem[method];
        
        const operationParameters = operation.parameters || [];
        const allParameters = [...pathParameters, ...operationParameters];
        
        const parameters = {
          path: [],
          query: [],
          header: [],
          cookie: []
        };
        
        for (const param of allParameters) {
          const resolvedParam = resolveAllRefs(param, rootSchema);
          if (parameters[resolvedParam.in]) {
            parameters[resolvedParam.in].push(resolvedParam);
          }
        }
        
        const requestBody = operation.requestBody 
          ? resolveAllRefs(operation.requestBody, rootSchema) 
          : null;
        
        const responses = {};
        for (const statusCode in operation.responses) {
          responses[statusCode] = resolveAllRefs(operation.responses[statusCode], rootSchema);
        }
        
        endpoints.push({
          path: pathKey,
          method: method.toUpperCase(),
          operationId: operation.operationId || `${method}${pathKey.replace(/[{}]/g, '')}`,
          summary: operation.summary || '',
          description: operation.description || '',
          tags: operation.tags || [],
          parameters,
          requestBody,
          responses,
          security: operation.security || null
        });
      }
    }
  }
  
  const schemas = openapi.components && openapi.components.schemas 
    ? resolveAllRefs(openapi.components.schemas, rootSchema) 
    : {};
  
  return {
    openapiVersion: openapi.openapi,
    info: openapi.info,
    servers: openapi.servers || [],
    endpoints,
    schemas,
    raw: openapi
  };
}

function getSuccessResponse(endpoint) {
  const successCodes = ['200', '201', '202', '204'];
  for (const code of successCodes) {
    if (endpoint.responses[code]) {
      return { statusCode: parseInt(code), response: endpoint.responses[code] };
    }
  }
  for (const code in endpoint.responses) {
    if (code.startsWith('2')) {
      return { statusCode: parseInt(code), response: endpoint.responses[code] };
    }
  }
  return null;
}

function getErrorResponse(endpoint, errorCode) {
  const code = String(errorCode);
  if (endpoint.responses[code]) {
    return { statusCode: parseInt(code), response: endpoint.responses[code] };
  }
  return null;
}

function getResponseSchema(response) {
  if (!response || !response.content) return null;
  
  const jsonContent = response.content['application/json'];
  if (jsonContent && jsonContent.schema) {
    return jsonContent.schema;
  }
  
  return null;
}

function getRequestBodySchema(requestBody) {
  if (!requestBody || !requestBody.content) return null;
  
  const jsonContent = requestBody.content['application/json'];
  if (jsonContent && jsonContent.schema) {
    return jsonContent.schema;
  }
  
  return null;
}

function getRequiredParameters(parameters) {
  const required = {
    path: [],
    query: [],
    header: [],
    cookie: []
  };
  
  for (const type in parameters) {
    required[type] = parameters[type].filter(p => p.required);
  }
  
  return required;
}

module.exports = {
  parseOpenAPI,
  getSuccessResponse,
  getErrorResponse,
  getResponseSchema,
  getRequestBodySchema,
  getRequiredParameters,
  resolveAllRefs
};
