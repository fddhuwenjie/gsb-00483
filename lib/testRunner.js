const axios = require('axios');
const Ajv = require('ajv');
const { buildAuthHeaders } = require('./auth');
const { createLifecycleManager } = require('./lifecycle');
const { createPluginManager } = require('./pluginLoader');

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  strictSchema: false,
  formats: {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    url: /^https?:\/\/.+/,
    date: /^\d{4}-\d{2}-\d{2}$/,
    'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    int32: true,
    int64: true,
    float: true,
    double: true
  }
});

async function executeTestCase(testCase, baseUrl, options = {}) {
  const result = {
    testId: testCase.id,
    description: testCase.description,
    endpoint: testCase.endpoint,
    type: testCase.type,
    status: 'pending',
    expectedStatus: testCase.expectedStatus,
    actualStatus: null,
    errors: [],
    warnings: [],
    request: { ...testCase.request },
    response: null,
    duration: 0,
    startTime: null,
    endTime: null,
    schemaValidation: {
      passed: false,
      errors: []
    }
  };

  result.startTime = Date.now();

  try {
    const url = buildUrl(baseUrl, testCase.request.path, testCase.request.queryParams);
    
    const authHeaders = buildAuthHeaders(options);
    
    const axiosConfig = {
      method: testCase.request.method.toLowerCase(),
      url: url,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...testCase.request.headers
      },
      validateStatus: () => true,
      timeout: options.timeout || 10000
    };

    if (testCase.request.body !== null && testCase.request.body !== undefined) {
      if (testCase.request.method !== 'GET' && testCase.request.method !== 'HEAD') {
        axiosConfig.data = testCase.request.body;
      }
    }

    const response = await axios(axiosConfig);
    
    result.actualStatus = response.status;
    result.response = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      body: response.data
    };

    validateTestCase(testCase, result);

    result.status = result.errors.length === 0 ? 'pass' : 'fail';

  } catch (error) {
    result.status = 'fail';
    result.errors.push({
      type: 'request_error',
      message: `Request failed: ${error.message}`,
      details: error.stack
    });
  }

  result.endTime = Date.now();
  result.duration = result.endTime - result.startTime;

  return result;
}

function buildUrl(baseUrl, path, queryParams) {
  let url = baseUrl.replace(/\/$/, '') + path;
  
  if (queryParams && Object.keys(queryParams).length > 0) {
    const searchParams = new URLSearchParams();
    for (const key in queryParams) {
      if (queryParams[key] !== undefined && queryParams[key] !== null) {
        searchParams.append(key, String(queryParams[key]));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      url += '?' + queryString;
    }
  }
  
  return url;
}

function validateTestCase(testCase, result) {
  const validation = testCase.validation || {};

  if (validation.checkStatus) {
    validateStatus(testCase, result);
  }

  if (validation.checkSchema && testCase.expectedSchema && result.response) {
    validateSchema(testCase.expectedSchema, result.response.data, result);
  }

  if (validation.checkRequiredFields && testCase.expectedSchema && result.response) {
    validateRequiredFields(testCase.expectedSchema, result.response.data, result);
  }

  if (validation.checkTypes && testCase.expectedSchema && result.response) {
    validateTypes(testCase.expectedSchema, result.response.data, result);
  }
}

function validateStatus(testCase, result) {
  if (result.actualStatus !== testCase.expectedStatus) {
    result.errors.push({
      type: 'status_mismatch',
      message: `Expected status ${testCase.expectedStatus}, got ${result.actualStatus}`,
      expected: testCase.expectedStatus,
      actual: result.actualStatus
    });
  }
}

function validateSchema(expectedSchema, actualData, result) {
  try {
    const validate = ajv.compile(expectedSchema);
    const valid = validate(actualData);
    
    result.schemaValidation.passed = valid;
    
    if (!valid) {
      result.schemaValidation.errors = validate.errors || [];
      
      for (const error of validate.errors || []) {
        result.errors.push({
          type: 'schema_validation',
          message: `Schema validation failed at ${error.instancePath || 'root'}: ${error.message}`,
          path: error.instancePath || '/',
          keyword: error.keyword,
          params: error.params,
          details: error
        });
      }
    }
  } catch (error) {
    result.errors.push({
      type: 'schema_error',
      message: `Schema validation error: ${error.message}`,
      details: error.stack
    });
  }
}

function validateRequiredFields(schema, data, result, path = '') {
  if (!schema || typeof schema !== 'object') return;
  
  if (schema.type === 'object' && schema.required && data && typeof data === 'object') {
    for (const requiredField of schema.required) {
      if (data[requiredField] === undefined) {
        const fieldPath = path ? `${path}.${requiredField}` : requiredField;
        result.errors.push({
          type: 'missing_required_field',
          message: `Missing required field: ${fieldPath}`,
          path: fieldPath,
          field: requiredField
        });
      }
    }
  }
  
  if (schema.type === 'object' && schema.properties && data && typeof data === 'object') {
    for (const propName in schema.properties) {
      if (data[propName] !== undefined) {
        validateRequiredFields(
          schema.properties[propName],
          data[propName],
          result,
          path ? `${path}.${propName}` : propName
        );
      }
    }
  }
  
  if (schema.type === 'array' && schema.items && Array.isArray(data)) {
    data.forEach((item, index) => {
      validateRequiredFields(
        schema.items,
        item,
        result,
        `${path}[${index}]`
      );
    });
  }
}

function validateTypes(schema, data, result, path = '') {
  if (!schema || typeof schema !== 'object') return;
  
  const expectedType = schema.type;
  if (expectedType && data !== undefined && data !== null) {
    const actualType = getJsonType(data);
    if (actualType !== expectedType && !(expectedType === 'integer' && actualType === 'number' && Number.isInteger(data))) {
      result.errors.push({
        type: 'type_mismatch',
        message: `Type mismatch at ${path || 'root'}: expected ${expectedType}, got ${actualType}`,
        path: path || '/',
        expected: expectedType,
        actual: actualType
      });
      return;
    }
  }
  
  if (expectedType === 'object' && schema.properties && data && typeof data === 'object') {
    for (const propName in schema.properties) {
      if (data[propName] !== undefined) {
        validateTypes(
          schema.properties[propName],
          data[propName],
          result,
          path ? `${path}.${propName}` : propName
        );
      }
    }
  }
  
  if (expectedType === 'array' && schema.items && Array.isArray(data)) {
    data.forEach((item, index) => {
      validateTypes(
        schema.items,
        item,
        result,
        `${path}[${index}]`
      );
    });
  }
}

function getJsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'string';
  return typeof value;
}

async function runAllTests(testSuite, baseUrl, options = {}) {
  const results = {
    apiInfo: testSuite.apiInfo,
    baseUrl,
    totalEndpoints: testSuite.totalEndpoints,
    totalTests: testSuite.totalTests,
    passed: 0,
    failed: 0,
    skipped: 0,
    startTime: Date.now(),
    endTime: null,
    duration: 0,
    endpointResults: {},
    testResults: [],
    endpointCoverage: {
      total: testSuite.totalEndpoints,
      tested: 0,
      notTested: [],
      details: []
    }
  };

  const testedEndpoints = new Set();
  
  const lifecycle = createLifecycleManager(baseUrl, {
    isolated: options.isolated || false,
    timeout: options.timeout || 10000,
    authOptions: {
      authType: options.authType,
      authToken: options.authToken,
      authUser: options.authUser,
      authPass: options.authPass,
      authKey: options.authKey,
      authHeader: options.authHeader
    },
    endpoints: testSuite.endpoints
  });

  const pluginManager = createPluginManager();
  if (options.plugins) {
    if (Array.isArray(options.plugins)) {
      for (const pluginDir of options.plugins) {
        pluginManager.loadPlugins(pluginDir);
      }
    } else {
      pluginManager.loadPlugins(options.plugins);
    }
  }

  await pluginManager.beforeAll(testSuite);

  if (options.beforeAllTests) {
    await options.beforeAllTests(testSuite);
  }

  for (const testCase of testSuite.testCases) {
    if (options.dryRun) {
      results.skipped++;
      results.testResults.push({
        ...testCase,
        status: 'skipped',
        duration: 0,
        errors: []
      });
      continue;
    }

    const endpointKey = `${testCase.endpoint.method} ${testCase.endpoint.path}`;
    testedEndpoints.add(endpointKey);

    let currentTestCase = testCase;
    let createdResources = [];
    
    currentTestCase = await pluginManager.beforeEach(currentTestCase);
    
    const setupResult = await lifecycle.setup(currentTestCase);
    currentTestCase = setupResult.testCase;
    createdResources = setupResult.createdResources;

    if (options.beforeEachTest) {
      await options.beforeEachTest(currentTestCase);
    }

    const testResult = await executeTestCase(currentTestCase, baseUrl, options);
    results.testResults.push(testResult);

    if (testResult.status === 'pass') {
      results.passed++;
    } else {
      results.failed++;
    }

    if (!results.endpointResults[endpointKey]) {
      results.endpointResults[endpointKey] = {
        endpoint: testCase.endpoint,
        tests: [],
        passed: 0,
        failed: 0,
        status: 'pending'
      };
    }
    results.endpointResults[endpointKey].tests.push(testResult);
    if (testResult.status === 'pass') {
      results.endpointResults[endpointKey].passed++;
    } else {
      results.endpointResults[endpointKey].failed++;
    }

    if (options.afterEachTest) {
      await options.afterEachTest(currentTestCase, testResult);
    }

    await pluginManager.afterEach(currentTestCase, testResult);

    await lifecycle.teardown(currentTestCase, testResult, createdResources);
  }

  await lifecycle.afterAll(results);
  
  await pluginManager.afterAll(results);

  for (const endpointKey in results.endpointResults) {
    const ep = results.endpointResults[endpointKey];
    ep.status = ep.failed === 0 ? 'pass' : 'fail';
    
    results.endpointCoverage.details.push({
      endpoint: ep.endpoint,
      method: ep.endpoint.method,
      path: ep.endpoint.path,
      status: ep.status,
      testsPassed: ep.passed,
      testsFailed: ep.failed,
      testsTotal: ep.tests.length
    });
  }

  results.endpointCoverage.tested = Object.keys(results.endpointResults).length;
  
  for (const endpoint of testSuite.endpoints) {
    const endpointKey = `${endpoint.method} ${endpoint.path}`;
    if (!testedEndpoints.has(endpointKey)) {
      results.endpointCoverage.notTested.push({
        method: endpoint.method,
        path: endpoint.path,
        operationId: endpoint.operationId
      });
    }
  }

  results.endTime = Date.now();
  results.duration = results.endTime - results.startTime;

  return results;
}

module.exports = {
  executeTestCase,
  runAllTests,
  validateTestCase,
  validateStatus,
  validateSchema,
  validateRequiredFields,
  validateTypes,
  buildUrl
};
