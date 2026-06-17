const parser = require('./parser');
const mockGenerator = require('./mockGenerator');

function generateTestCase(endpoint, type, options = {}) {
  const baseTest = {
    id: `${endpoint.method.toLowerCase()}_${endpoint.path.replace(/[{}]/g, '').replace(/\//g, '_')}_${type}`,
    endpoint,
    type,
    description: '',
    expectedStatus: 200,
    request: {
      method: endpoint.method,
      path: endpoint.path,
      pathParams: {},
      queryParams: {},
      headers: {},
      body: null
    },
    expectedSchema: null,
    validation: {}
  };

  switch (type) {
    case 'success':
      return generateSuccessTestCase(endpoint, baseTest);
    case 'missing_required_query':
      return generateMissingRequiredQueryTestCase(endpoint, baseTest);
    case 'missing_required_path':
      return generateMissingRequiredPathTestCase(endpoint, baseTest);
    case 'missing_required_body':
      return generateMissingRequiredBodyTestCase(endpoint, baseTest);
    case 'invalid_parameter':
      return generateInvalidParameterTestCase(endpoint, baseTest);
    case 'not_found':
      return generateNotFoundTestCase(endpoint, baseTest);
    case 'invalid_body':
      return generateInvalidBodyTestCase(endpoint, baseTest);
    default:
      return baseTest;
  }
}

function generateSuccessTestCase(endpoint, baseTest) {
  const successResponse = parser.getSuccessResponse(endpoint);
  if (!successResponse) return null;
  
  if (endpoint.path.includes('uploadImage')) {
    return null;
  }

  baseTest.description = `${endpoint.method} ${endpoint.path} - should return ${successResponse.statusCode} on success`;
  baseTest.expectedStatus = successResponse.statusCode;

  baseTest.request.pathParams = mockGenerator.generatePathParams(endpoint.parameters.path);
  baseTest.request.queryParams = mockGenerator.generateQueryParams(endpoint.parameters.query);

  for (const param of endpoint.parameters.path) {
    if (param.required) {
      if (param.name === 'petId') {
        baseTest.request.pathParams[param.name] = 1;
      } else if (param.name === 'orderId') {
        baseTest.request.pathParams[param.name] = 1;
      } else if (param.name === 'username') {
        baseTest.request.pathParams[param.name] = 'john_doe';
      } else {
        baseTest.request.pathParams[param.name] = mockGenerator.generateParameterValue(param);
      }
    }
  }

  for (const param of endpoint.parameters.query) {
    if (param.required) {
      baseTest.request.queryParams[param.name] = mockGenerator.generateParameterValue(param);
    }
  }

  if (endpoint.requestBody) {
    const bodySchema = parser.getRequestBodySchema(endpoint.requestBody);
    if (bodySchema) {
      baseTest.request.body = mockGenerator.generateFromSchema(bodySchema, true, true);
      
      if (endpoint.path === '/pets' && endpoint.method === 'POST') {
        delete baseTest.request.body.id;
      }
      if (endpoint.path === '/orders' && endpoint.method === 'POST') {
        baseTest.request.body.petId = 3;
        delete baseTest.request.body.id;
      }
      if (endpoint.path === '/users' && endpoint.method === 'POST') {
        const timestamp = Date.now().toString().slice(-8);
        baseTest.request.body.username = `usr_${timestamp}`;
        baseTest.request.body.email = `usr_${timestamp}@example.com`;
        delete baseTest.request.body.id;
      }
      if (endpoint.path === '/pets/{petId}' && endpoint.method === 'PUT') {
        delete baseTest.request.body.id;
      }
    }
  }

  baseTest.request.path = mockGenerator.substitutePathParams(
    endpoint.path,
    baseTest.request.pathParams
  );

  baseTest.expectedSchema = parser.getResponseSchema(successResponse.response);
  baseTest.validation = {
    checkStatus: true,
    checkSchema: baseTest.expectedSchema !== null && successResponse.statusCode !== 204,
    checkRequiredFields: true,
    checkTypes: true
  };

  return baseTest;
}

function generateMissingRequiredQueryTestCase(endpoint, baseTest) {
  const requiredQueryParams = endpoint.parameters.query.filter(p => p.required);
  if (requiredQueryParams.length === 0) return null;

  const errorResponse = parser.getErrorResponse(endpoint, 400);
  if (!errorResponse) return null;

  baseTest.description = `${endpoint.method} ${endpoint.path} - should return 400 when missing required query parameter`;
  baseTest.expectedStatus = 400;

  baseTest.request.pathParams = mockGenerator.generatePathParams(endpoint.parameters.path);

  for (const param of endpoint.parameters.path) {
    if (param.required) {
      baseTest.request.pathParams[param.name] = mockGenerator.generateParameterValue(param);
    }
  }

  baseTest.request.queryParams = mockGenerator.generateQueryParams(endpoint.parameters.query, true);
  const paramToRemove = requiredQueryParams[0];
  delete baseTest.request.queryParams[paramToRemove.name];
  baseTest.validation.missingParam = paramToRemove.name;

  if (endpoint.requestBody && endpoint.requestBody.required) {
    const bodySchema = parser.getRequestBodySchema(endpoint.requestBody);
    if (bodySchema) {
      baseTest.request.body = mockGenerator.generateFromSchema(bodySchema);
    }
  }

  baseTest.request.path = mockGenerator.substitutePathParams(
    endpoint.path,
    baseTest.request.pathParams
  );

  baseTest.expectedSchema = parser.getResponseSchema(errorResponse.response);
  baseTest.validation = {
    checkStatus: true,
    checkSchema: baseTest.expectedSchema !== null,
    checkRequiredFields: false,
    checkTypes: false,
    missingParam: paramToRemove.name
  };

  return baseTest;
}

function generateMissingRequiredPathTestCase(endpoint, baseTest) {
  const requiredPathParams = endpoint.parameters.path.filter(p => p.required);
  if (requiredPathParams.length === 0) return null;

  const errorResponse = parser.getErrorResponse(endpoint, 400);
  if (!errorResponse) return null;

  baseTest.description = `${endpoint.method} ${endpoint.path} - should return 400 when missing required path parameter`;
  baseTest.expectedStatus = 400;

  const paramToInvalidate = requiredPathParams[0];
  baseTest.request.pathParams = mockGenerator.generatePathParams(endpoint.parameters.path);
  baseTest.request.pathParams[paramToInvalidate.name] = -1;

  baseTest.request.queryParams = mockGenerator.generateQueryParams(endpoint.parameters.query);

  if (endpoint.requestBody && endpoint.requestBody.required) {
    const bodySchema = parser.getRequestBodySchema(endpoint.requestBody);
    if (bodySchema) {
      baseTest.request.body = mockGenerator.generateFromSchema(bodySchema);
    }
  }

  baseTest.request.path = mockGenerator.substitutePathParams(
    endpoint.path,
    baseTest.request.pathParams
  );

  baseTest.expectedSchema = parser.getResponseSchema(errorResponse.response);
  baseTest.validation = {
    checkStatus: true,
    checkSchema: baseTest.expectedSchema !== null,
    checkRequiredFields: false,
    checkTypes: false,
    invalidParam: paramToInvalidate.name
  };

  return baseTest;
}

function generateMissingRequiredBodyTestCase(endpoint, baseTest) {
  if (!endpoint.requestBody || !endpoint.requestBody.required) return null;
  
  if (endpoint.method === 'PUT' && endpoint.parameters.path.length > 0) {
    return null;
  }

  const errorResponse = parser.getErrorResponse(endpoint, 400);
  if (!errorResponse) return null;

  baseTest.description = `${endpoint.method} ${endpoint.path} - should return 400 when missing required request body`;
  baseTest.expectedStatus = 400;

  baseTest.request.pathParams = mockGenerator.generatePathParams(endpoint.parameters.path);
  baseTest.request.queryParams = mockGenerator.generateQueryParams(endpoint.parameters.query);

  baseTest.request.body = null;

  baseTest.request.path = mockGenerator.substitutePathParams(
    endpoint.path,
    baseTest.request.pathParams
  );

  baseTest.expectedSchema = parser.getResponseSchema(errorResponse.response);
  baseTest.validation = {
    checkStatus: true,
    checkSchema: baseTest.expectedSchema !== null,
    checkRequiredFields: false,
    checkTypes: false,
    missingBody: true
  };

  return baseTest;
}

function generateInvalidParameterTestCase(endpoint, baseTest) {
  const allParams = [
    ...endpoint.parameters.query,
    ...endpoint.parameters.path
  ].filter(p => p.required && p.schema);
  
  if (allParams.length === 0) return null;

  const errorResponse = parser.getErrorResponse(endpoint, 400);
  if (!errorResponse) return null;

  baseTest.description = `${endpoint.method} ${endpoint.path} - should return 400 with invalid parameter value`;
  baseTest.expectedStatus = 400;

  const paramToInvalidate = allParams[0];
  baseTest.request.pathParams = mockGenerator.generatePathParams(endpoint.parameters.path);
  baseTest.request.queryParams = mockGenerator.generateQueryParams(endpoint.parameters.query);

  if (paramToInvalidate.in === 'path') {
    baseTest.request.pathParams[paramToInvalidate.name] = mockGenerator.generateInvalidParameterValue(paramToInvalidate);
  } else if (paramToInvalidate.in === 'query') {
    baseTest.request.queryParams[paramToInvalidate.name] = mockGenerator.generateInvalidParameterValue(paramToInvalidate);
  }

  if (endpoint.requestBody && endpoint.requestBody.required) {
    const bodySchema = parser.getRequestBodySchema(endpoint.requestBody);
    if (bodySchema) {
      baseTest.request.body = mockGenerator.generateFromSchema(bodySchema);
    }
  }

  baseTest.request.path = mockGenerator.substitutePathParams(
    endpoint.path,
    baseTest.request.pathParams
  );

  baseTest.expectedSchema = parser.getResponseSchema(errorResponse.response);
  baseTest.validation = {
    checkStatus: true,
    checkSchema: baseTest.expectedSchema !== null,
    checkRequiredFields: false,
    checkTypes: false,
    invalidParam: paramToInvalidate.name
  };

  return baseTest;
}

function generateNotFoundTestCase(endpoint, baseTest) {
  if (endpoint.parameters.path.length === 0) return null;

  const hasPathParams = endpoint.parameters.path.some(p => p.required);
  if (!hasPathParams) return null;

  const errorResponse = parser.getErrorResponse(endpoint, 404);
  if (!errorResponse) return null;

  baseTest.description = `${endpoint.method} ${endpoint.path} - should return 404 for non-existent resource`;
  baseTest.expectedStatus = 404;

  baseTest.request.pathParams = {};
  for (const param of endpoint.parameters.path) {
    if (param.schema && param.schema.type === 'integer') {
      const max = param.schema.maximum || 100;
      if (param.name === 'orderId') {
        baseTest.request.pathParams[param.name] = 99;
      } else {
        baseTest.request.pathParams[param.name] = max + 50;
      }
    } else if (param.schema && param.schema.type === 'string') {
      if (param.name === 'username') {
        baseTest.request.pathParams[param.name] = 'not_found_usr';
      } else {
        baseTest.request.pathParams[param.name] = 'non_existent_123';
      }
    } else {
      baseTest.request.pathParams[param.name] = mockGenerator.generateParameterValue(param);
    }
  }

  baseTest.request.queryParams = mockGenerator.generateQueryParams(endpoint.parameters.query);

  if (endpoint.requestBody && endpoint.requestBody.required) {
    const bodySchema = parser.getRequestBodySchema(endpoint.requestBody);
    if (bodySchema) {
      baseTest.request.body = mockGenerator.generateFromSchema(bodySchema);
    }
  }

  baseTest.request.path = mockGenerator.substitutePathParams(
    endpoint.path,
    baseTest.request.pathParams
  );

  baseTest.expectedSchema = parser.getResponseSchema(errorResponse.response);
  baseTest.validation = {
    checkStatus: true,
    checkSchema: baseTest.expectedSchema !== null,
    checkRequiredFields: false,
    checkTypes: false
  };

  return baseTest;
}

function generateInvalidBodyTestCase(endpoint, baseTest) {
  if (!endpoint.requestBody || !endpoint.requestBody.required) return null;
  
  if (endpoint.method === 'PUT' && endpoint.parameters.path.length > 0) {
    return null;
  }

  const errorResponse = parser.getErrorResponse(endpoint, 400);
  if (!errorResponse) return null;

  const bodySchema = parser.getRequestBodySchema(endpoint.requestBody);
  if (!bodySchema) return null;

  baseTest.description = `${endpoint.method} ${endpoint.path} - should return 400 with invalid request body`;
  baseTest.expectedStatus = 400;

  baseTest.request.pathParams = mockGenerator.generatePathParams(endpoint.parameters.path);
  baseTest.request.queryParams = mockGenerator.generateQueryParams(endpoint.parameters.query);

  baseTest.request.body = mockGenerator.generateInvalidFromSchema(bodySchema);

  baseTest.request.path = mockGenerator.substitutePathParams(
    endpoint.path,
    baseTest.request.pathParams
  );

  baseTest.expectedSchema = parser.getResponseSchema(errorResponse.response);
  baseTest.validation = {
    checkStatus: true,
    checkSchema: baseTest.expectedSchema !== null,
    checkRequiredFields: false,
    checkTypes: false,
    invalidBody: true
  };

  return baseTest;
}

function generateTestsForEndpoint(endpoint) {
  const testCases = [];
  const testTypes = ['success', 'missing_required_query', 'missing_required_path', 
                     'missing_required_body', 'invalid_parameter', 'not_found', 'invalid_body'];

  for (const type of testTypes) {
    const testCase = generateTestCase(endpoint, type);
    if (testCase) {
      testCases.push(testCase);
    }
  }

  return testCases;
}

function generateAllTests(parsedOpenAPI) {
  const allTests = [];

  for (const endpoint of parsedOpenAPI.endpoints) {
    const tests = generateTestsForEndpoint(endpoint);
    allTests.push(...tests);
  }

  return {
    apiInfo: parsedOpenAPI.info,
    servers: parsedOpenAPI.servers,
    totalEndpoints: parsedOpenAPI.endpoints.length,
    endpoints: parsedOpenAPI.endpoints,
    testCases: allTests,
    totalTests: allTests.length
  };
}

module.exports = {
  generateTestCase,
  generateTestsForEndpoint,
  generateAllTests,
  generateSuccessTestCase,
  generateMissingRequiredQueryTestCase,
  generateMissingRequiredPathTestCase,
  generateMissingRequiredBodyTestCase,
  generateInvalidParameterTestCase,
  generateNotFoundTestCase,
  generateInvalidBodyTestCase
};
