#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const parser = require('../lib/parser');
const testGenerator = require('../lib/testGenerator');
const testRunner = require('../lib/testRunner');
const reporter = require('../lib/reporter');
const auth = require('../lib/auth');
const pluginLoader = require('../lib/pluginLoader');
const lifecycle = require('../lib/lifecycle');

const OPENAPI_FILE = path.resolve(__dirname, '..', 'openapi.yaml');
const MOCK_SERVER_PORT = 3099;
const MOCK_BASE_URL = `http://localhost:${MOCK_SERVER_PORT}`;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'test-reports', 'regression-test-output');

const regressionResults = {
  suiteName: 'API Contract Tester - Regression Test Suite',
  startTime: Date.now(),
  endTime: null,
  duration: 0,
  totalTests: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  testResults: [],
  coverage: {}
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(str, substr, message) {
  if (!str.includes(substr)) {
    throw new Error(`${message || 'Assertion failed'}: expected string to include "${substr}"`);
  }
}

function runTest(name, fn) {
  regressionResults.totalTests++;
  const testResult = {
    name,
    status: 'pending',
    duration: 0,
    startTime: Date.now(),
    errors: [],
    category: name.split(' > ')[0]
  };

  try {
    fn();
    testResult.status = 'pass';
    regressionResults.passed++;
  } catch (error) {
    testResult.status = 'fail';
    testResult.errors.push({
      type: 'assertion_failed',
      message: error.message,
      details: error.stack
    });
    regressionResults.failed++;
  }

  testResult.endTime = Date.now();
  testResult.duration = testResult.endTime - testResult.startTime;
  regressionResults.testResults.push(testResult);

  const icon = testResult.status === 'pass' ? '✅' : '❌';
  console.log(`  ${icon} ${name} (${testResult.duration}ms)`);
}

function runAsyncTest(name, fn) {
  regressionResults.totalTests++;
  const testResult = {
    name,
    status: 'pending',
    duration: 0,
    startTime: Date.now(),
    errors: [],
    category: name.split(' > ')[0]
  };

  return fn()
    .then(() => {
      testResult.status = 'pass';
      regressionResults.passed++;
    })
    .catch((error) => {
      testResult.status = 'fail';
      testResult.errors.push({
        type: 'assertion_failed',
        message: error.message,
        details: error.stack
      });
      regressionResults.failed++;
    })
    .then(() => {
      testResult.endTime = Date.now();
      testResult.duration = testResult.endTime - testResult.startTime;
      regressionResults.testResults.push(testResult);

      const icon = testResult.status === 'pass' ? '✅' : '❌';
      console.log(`  ${icon} ${name} (${testResult.duration}ms)`);
    });
}

let mockServerProcess = null;

function startMockServer() {
  return new Promise((resolve, reject) => {
    const mockServerPath = path.resolve(__dirname, '..', 'mock-server.js');
    const mockServerCode = fs.readFileSync(mockServerPath, 'utf8');
    
    const modifiedCode = mockServerCode.replace(
      'const PORT = 3000;',
      `const PORT = ${MOCK_SERVER_PORT};`
    );
    
    const tempServerPath = path.resolve(__dirname, '.mock-server-temp.js');
    fs.writeFileSync(tempServerPath, modifiedCode);
    
    mockServerProcess = spawn('node', [tempServerPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error('Mock server startup timeout'));
      }
    }, 5000);

    mockServerProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Mock Server is running') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        setTimeout(resolve, 500);
      }
    });

    mockServerProcess.stderr.on('data', (data) => {
    });

    mockServerProcess.on('exit', (code) => {
      if (!resolved && code !== 0) {
        reject(new Error(`Mock server exited with code ${code}`));
      }
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServerProcess) {
      mockServerProcess.kill('SIGTERM');
      mockServerProcess.on('exit', () => {
        const tempServerPath = path.resolve(__dirname, '.mock-server-temp.js');
        if (fs.existsSync(tempServerPath)) {
          fs.unlinkSync(tempServerPath);
        }
        resolve();
      });
      setTimeout(resolve, 2000);
    } else {
      resolve();
    }
  });
}

console.log('\n' + '═'.repeat(70));
console.log('  API Contract Tester - Regression Test Suite');
console.log('═'.repeat(70) + '\n');

console.log('📋 Phase 1: Test Generation Tests\n');

runTest('Test Generation > parseOpenAPI returns valid structure', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  assert(parsed !== null, 'Parsed result should not be null');
  assertEqual(typeof parsed.info, 'object', 'info should be an object');
  assert(parsed.endpoints.length > 0, 'Should have endpoints');
  assert(parsed.schemas !== null, 'Should have schemas');
  assertEqual(parsed.openapiVersion, '3.0.0', 'OpenAPI version should be 3.0.0');
});

runTest('Test Generation > endpoint count matches expected', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  assertEqual(parsed.endpoints.length, 12, 'Should have 12 endpoints');
});

runTest('Test Generation > generateAllTests produces test suite', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const suite = testGenerator.generateAllTests(parsed);
  assert(suite.testCases.length > 0, 'Should have test cases');
  assertEqual(suite.totalTests, suite.testCases.length, 'totalTests should match testCases length');
  assertEqual(suite.totalEndpoints, parsed.endpoints.length, 'totalEndpoints should match');
});

runTest('Test Generation > success test case has expected structure', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const getPetsEp = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets');
  const tests = testGenerator.generateTestsForEndpoint(getPetsEp);
  const successTest = tests.find(t => t.type === 'success');
  assert(successTest !== undefined, 'Should have success test');
  assertEqual(successTest.expectedStatus, 200, 'Expected status should be 200');
  assert(successTest.validation.checkStatus, 'Should check status');
  assert(successTest.validation.checkSchema, 'Should check schema');
  assert(successTest.request.method === 'GET', 'Method should be GET');
});

runTest('Test Generation > not_found test case for path param endpoints', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const getPetEp = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
  const tests = testGenerator.generateTestsForEndpoint(getPetEp);
  const notFoundTest = tests.find(t => t.type === 'not_found');
  assert(notFoundTest !== undefined, 'Should have not_found test');
  assertEqual(notFoundTest.expectedStatus, 404, 'Expected status should be 404');
});

runTest('Test Generation > missing_required_body test for POST endpoints', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const postPetEp = parsed.endpoints.find(e => e.method === 'POST' && e.path === '/pets');
  const tests = testGenerator.generateTestsForEndpoint(postPetEp);
  const missingBodyTest = tests.find(t => t.type === 'missing_required_body');
  assert(missingBodyTest !== undefined, 'Should have missing_required_body test');
  assertEqual(missingBodyTest.request.body, null, 'Body should be null');
});

runTest('Test Generation > invalid_body test generates invalid schema', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const postPetEp = parsed.endpoints.find(e => e.method === 'POST' && e.path === '/pets');
  const tests = testGenerator.generateTestsForEndpoint(postPetEp);
  const invalidBodyTest = tests.find(t => t.type === 'invalid_body');
  assert(invalidBodyTest !== undefined, 'Should have invalid_body test');
  assertEqual(invalidBodyTest.expectedStatus, 400, 'Expected status should be 400');
  assert(invalidBodyTest.validation.invalidBody === true, 'Should mark invalidBody');
});

runTest('Test Generation > missing_required_query test for query params', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const getPetsEp = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets');
  const tests = testGenerator.generateTestsForEndpoint(getPetsEp);
  const missingQueryTest = tests.find(t => t.type === 'missing_required_query');
  assert(missingQueryTest === undefined, 'GET /pets has no required query params, should not have test');
});

runTest('Test Generation > uploadImage endpoint skipped for success test', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const uploadEp = parsed.endpoints.find(e => e.method === 'POST' && e.path === '/pets/{petId}/uploadImage');
  const tests = testGenerator.generateTestsForEndpoint(uploadEp);
  const successTest = tests.find(t => t.type === 'success');
  assert(successTest === undefined, 'uploadImage should not have success test');
});

runTest('Test Generation > test case ID format is consistent', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const getPetEp = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
  const tests = testGenerator.generateTestsForEndpoint(getPetEp);
  tests.forEach(t => {
    assert(t.id.includes('get_'), 'ID should start with method');
    assert(t.id.includes('_pets_petId_'), 'ID should include path');
  });
});

console.log('\n📋 Phase 2: Filter Tests\n');

runTest('Filter > filter by description pattern', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  let testSuite = testGenerator.generateAllTests(parsed);
  const originalCount = testSuite.testCases.length;
  
  const pattern = new RegExp('pet', 'i');
  testSuite.testCases = testSuite.testCases.filter(t => 
    pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method)
  );
  testSuite.totalTests = testSuite.testCases.length;
  
  assert(testSuite.totalTests < originalCount, 'Filtered count should be less than original');
  assert(testSuite.testCases.length > 0, 'Should still have some tests');
  testSuite.testCases.forEach(t => {
    const matches = pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method);
    assert(matches, `Test ${t.description} should match filter`);
  });
});

runTest('Filter > filter by path pattern', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  let testSuite = testGenerator.generateAllTests(parsed);
  
  const pattern = new RegExp('^/orders', 'i');
  testSuite.testCases = testSuite.testCases.filter(t => pattern.test(t.endpoint.path));
  testSuite.totalTests = testSuite.testCases.length;
  
  testSuite.testCases.forEach(t => {
    assert(t.endpoint.path.startsWith('/orders'), `Path ${t.endpoint.path} should start with /orders`);
  });
});

runTest('Filter > filter by method pattern', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  let testSuite = testGenerator.generateAllTests(parsed);
  
  const pattern = new RegExp('^POST$', 'i');
  testSuite.testCases = testSuite.testCases.filter(t => pattern.test(t.endpoint.method));
  testSuite.totalTests = testSuite.testCases.length;
  
  testSuite.testCases.forEach(t => {
    assertEqual(t.endpoint.method, 'POST', 'Method should be POST');
  });
});

runTest('Filter > no matching pattern returns empty', () => {
  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  let testSuite = testGenerator.generateAllTests(parsed);
  
  const pattern = new RegExp('nonexistent_pattern_xyz', 'i');
  testSuite.testCases = testSuite.testCases.filter(t => 
    pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method)
  );
  testSuite.totalTests = testSuite.testCases.length;
  
  assertEqual(testSuite.totalTests, 0, 'Should have 0 tests after filtering');
});

console.log('\n📋 Phase 3: Auth Tests\n');

runTest('Auth > buildAuthHeaders for bearer token', () => {
  const headers = auth.buildAuthHeaders({
    authType: 'bearer',
    authToken: 'test-token-123'
  });
  assertEqual(headers['Authorization'], 'Bearer test-token-123', 'Should have Bearer token');
});

runTest('Auth > buildAuthHeaders for basic auth', () => {
  const headers = auth.buildAuthHeaders({
    authType: 'basic',
    authUser: 'admin',
    authPass: 'secret123'
  });
  const expected = 'Basic ' + Buffer.from('admin:secret123').toString('base64');
  assertEqual(headers['Authorization'], expected, 'Should have Basic auth header');
});

runTest('Auth > buildAuthHeaders for apikey with default header', () => {
  const headers = auth.buildAuthHeaders({
    authType: 'apikey',
    authKey: 'my-api-key'
  });
  assertEqual(headers['X-API-Key'], 'my-api-key', 'Should have X-API-Key header');
});

runTest('Auth > buildAuthHeaders for apikey with custom header', () => {
  const headers = auth.buildAuthHeaders({
    authType: 'apikey',
    authKey: 'my-api-key',
    authHeader: 'X-Custom-Key'
  });
  assertEqual(headers['X-Custom-Key'], 'my-api-key', 'Should have custom header');
});

runTest('Auth > buildAuthHeaders throws for missing bearer token', () => {
  let threw = false;
  try {
    auth.buildAuthHeaders({ authType: 'bearer' });
  } catch (e) {
    threw = true;
    assertIncludes(e.message, 'Bearer auth requires --auth-token', 'Error message should mention token');
  }
  assert(threw, 'Should throw error for missing token');
});

runTest('Auth > buildAuthHeaders throws for missing basic auth credentials', () => {
  let threw = false;
  try {
    auth.buildAuthHeaders({ authType: 'basic', authUser: 'admin' });
  } catch (e) {
    threw = true;
    assertIncludes(e.message, 'Basic auth requires', 'Error message should mention credentials');
  }
  assert(threw, 'Should throw error for missing credentials');
});

runTest('Auth > buildAuthHeaders throws for unknown auth type', () => {
  let threw = false;
  try {
    auth.buildAuthHeaders({ authType: 'oauth2' });
  } catch (e) {
    threw = true;
    assertIncludes(e.message, 'Unknown auth type', 'Error message should mention unknown type');
  }
  assert(threw, 'Should throw error for unknown auth type');
});

runTest('Auth > buildAuthHeaders returns empty for no auth type', () => {
  const headers = auth.buildAuthHeaders({});
  assertEqual(Object.keys(headers).length, 0, 'Should have no headers');
});

runTest('Auth > mergeAuthOptions merges config file with CLI options', () => {
  const configPath = path.resolve(__dirname, '..', 'auth-config.json');
  const options = auth.mergeAuthOptions({
    authConfig: configPath,
    authToken: 'cli-override-token'
  });
  assertEqual(options.authType, 'bearer', 'Auth type should come from config');
  assertEqual(options.authToken, 'cli-override-token', 'CLI option should override config');
});

runTest('Auth > loadAuthConfig reads JSON file correctly', () => {
  const configPath = path.resolve(__dirname, '..', 'auth-config.json');
  const config = auth.loadAuthConfig(configPath);
  assertEqual(config.authType, 'bearer', 'Should have bearer auth type');
  assertEqual(config.authToken, 'admin-token-12345', 'Should have correct token');
});

runTest('Auth > loadAuthConfig throws for missing file', () => {
  let threw = false;
  try {
    auth.loadAuthConfig('/nonexistent/path/config.json');
  } catch (e) {
    threw = true;
    assertIncludes(e.message, 'not found', 'Error should mention file not found');
  }
  assert(threw, 'Should throw for missing file');
});

console.log('\n📋 Phase 4: Plugin Loader Tests\n');

runTest('Plugin Loader > createPluginManager returns valid instance', () => {
  const pm = pluginLoader.createPluginManager();
  assert(pm !== null, 'Should create plugin manager');
  assertEqual(pm.getPluginCount(), 0, 'Should start with 0 plugins');
});

runTest('Plugin Loader > loadPlugins from plugins directory', () => {
  const pm = pluginLoader.createPluginManager();
  const pluginDir = path.resolve(__dirname, '..', 'plugins');
  const loaded = pm.loadPlugins(pluginDir);
  assert(loaded.length > 0, 'Should load at least one plugin');
  assert(pm.getPluginCount() > 0, 'Plugin count should be > 0');
  assert(pm.getPluginNames().includes('log-plugin'), 'Should have log-plugin');
});

runTest('Plugin Loader > loadPlugins from nonexistent directory returns empty', () => {
  const pm = pluginLoader.createPluginManager();
  const loaded = pm.loadPlugins('/nonexistent/plugins/dir');
  assertEqual(loaded.length, 0, 'Should return empty array');
  assertEqual(pm.getPluginCount(), 0, 'Should have 0 plugins');
});

runTest('Plugin Loader > beforeAll hook executes', async () => {
  const pm = pluginLoader.createPluginManager();
  const pluginDir = path.resolve(__dirname, '..', 'plugins');
  pm.loadPlugins(pluginDir);
  await pm.beforeAll({ totalTests: 5 });
});

runTest('Plugin Loader > beforeEach hook returns test case', async () => {
  const pm = pluginLoader.createPluginManager();
  const pluginDir = path.resolve(__dirname, '..', 'plugins');
  pm.loadPlugins(pluginDir);
  const testCase = { id: 'test-1', description: 'Test 1' };
  const result = await pm.beforeEach(testCase);
  assert(result !== undefined, 'Should return a result');
});

runTest('Plugin Loader > afterEach hook executes', async () => {
  const pm = pluginLoader.createPluginManager();
  const pluginDir = path.resolve(__dirname, '..', 'plugins');
  pm.loadPlugins(pluginDir);
  await pm.afterEach({ id: 'test-1' }, { status: 'pass' });
});

runTest('Plugin Loader > afterAll hook executes', async () => {
  const pm = pluginLoader.createPluginManager();
  const pluginDir = path.resolve(__dirname, '..', 'plugins');
  pm.loadPlugins(pluginDir);
  await pm.afterAll({ passed: 5, failed: 0 });
});

console.log('\n📋 Phase 5: Isolated Mode Tests\n');

runTest('Isolated Mode > createLifecycleManager with isolated=false', () => {
  const lm = lifecycle.createLifecycleManager(MOCK_BASE_URL, { isolated: false });
  assert(lm !== null, 'Should create lifecycle manager');
  assertEqual(lm.isolated, false, 'isolated should be false');
});

runTest('Isolated Mode > createLifecycleManager with isolated=true', () => {
  const lm = lifecycle.createLifecycleManager(MOCK_BASE_URL, { isolated: true });
  assert(lm !== null, 'Should create lifecycle manager');
  assertEqual(lm.isolated, true, 'isolated should be true');
});

runTest('Isolated Mode > setup without isolated returns unchanged testCase', async () => {
  const lm = lifecycle.createLifecycleManager(MOCK_BASE_URL, { isolated: false });
  const testCase = { type: 'success', endpoint: { method: 'GET', path: '/pets/{petId}' } };
  const result = await lm.setup(testCase);
  assertEqual(result.testCase, testCase, 'testCase should be unchanged');
  assertEqual(result.createdResources.length, 0, 'Should have no created resources');
});

runTest('Isolated Mode > teardown without isolated does nothing', async () => {
  const lm = lifecycle.createLifecycleManager(MOCK_BASE_URL, { isolated: false });
  await lm.teardown({}, {}, []);
});

runTest('Isolated Mode > getResourceType identifies pet resource', () => {
  const lm = lifecycle.createLifecycleManager(MOCK_BASE_URL, { isolated: true });
  assertEqual(lm.getResourceType('/pets/123'), 'pet', 'Should identify pet resource');
  assertEqual(lm.getResourceType('/orders/123'), 'order', 'Should identify order resource');
  assertEqual(lm.getResourceType('/users/test'), 'user', 'Should identify user resource');
  assertEqual(lm.getResourceType('/unknown'), null, 'Should return null for unknown');
});

runTest('Isolated Mode > getCollectionPath extracts collection path', () => {
  const lm = lifecycle.createLifecycleManager(MOCK_BASE_URL, { isolated: true });
  assertEqual(lm.getCollectionPath('/pets/123'), '/pets', 'Should get pets collection');
  assertEqual(lm.getCollectionPath('/orders/123'), '/orders', 'Should get orders collection');
  assertEqual(lm.getCollectionPath('/users/test'), '/users', 'Should get users collection');
  assertEqual(lm.getCollectionPath('/pets'), null, 'Should return null for non-detail path');
});

runTest('Isolated Mode > getIdField returns correct field name', () => {
  const lm = lifecycle.createLifecycleManager(MOCK_BASE_URL, { isolated: true });
  assertEqual(lm.getIdField('pet'), 'id', 'Pet id field should be id');
  assertEqual(lm.getIdField('order'), 'id', 'Order id field should be id');
  assertEqual(lm.getIdField('user'), 'username', 'User id field should be username');
});

console.log('\n📋 Phase 6: Reporter Tests\n');

runTest('Reporter > generateMarkdownReport has expected sections', () => {
  const mockResults = {
    apiInfo: { title: 'Test API', version: '1.0.0' },
    baseUrl: 'http://localhost:3000',
    totalEndpoints: 5,
    totalTests: 10,
    passed: 8,
    failed: 2,
    skipped: 0,
    duration: 1500,
    startTime: Date.now(),
    testResults: [
      {
        status: 'pass',
        description: 'Test 1',
        endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
        type: 'success',
        expectedStatus: 200,
        actualStatus: 200,
        duration: 100,
        request: { method: 'GET', path: '/pets' },
        response: { data: { id: 1 } },
        errors: [],
        schemaValidation: { passed: true, errors: [] }
      },
      {
        status: 'fail',
        description: 'Test 2',
        endpoint: { method: 'POST', path: '/pets', tags: ['pets'] },
        type: 'success',
        expectedStatus: 201,
        actualStatus: 400,
        duration: 50,
        request: { method: 'POST', path: '/pets', body: {} },
        response: { data: { code: 400, message: 'Error' } },
        errors: [{ type: 'status_mismatch', message: 'Status mismatch', expected: 201, actual: 400 }],
        schemaValidation: { passed: false, errors: [{ message: 'Invalid', keyword: 'required', instancePath: '/name' }] }
      }
    ],
    endpointCoverage: {
      total: 5,
      tested: 2,
      notTested: [{ method: 'DELETE', path: '/pets/{petId}', operationId: 'deletePet' }],
      details: [
        { endpoint: { method: 'GET', path: '/pets' }, method: 'GET', path: '/pets', status: 'pass', testsPassed: 1, testsFailed: 0, testsTotal: 1 },
        { endpoint: { method: 'POST', path: '/pets' }, method: 'POST', path: '/pets', status: 'fail', testsPassed: 0, testsFailed: 1, testsTotal: 1 }
      ]
    }
  };

  const md = reporter.generateMarkdownReport(mockResults);
  assertIncludes(md, '# API Contract Test Report', 'Should have title');
  assertIncludes(md, '## Summary', 'Should have summary section');
  assertIncludes(md, '## Endpoint Coverage', 'Should have endpoint coverage');
  assertIncludes(md, '## Test Results', 'Should have test results');
  assertIncludes(md, '## Schema Validation Details', 'Should have schema validation section');
  assertIncludes(md, '### ❌ Failed Tests', 'Should have failed tests section');
  assertIncludes(md, '### ✅ Passed Tests', 'Should have passed tests section');
});

runTest('Reporter > generateHTMLReport has expected structure', () => {
  const mockResults = {
    apiInfo: { title: 'Test API', version: '1.0.0' },
    baseUrl: 'http://localhost:3000',
    totalEndpoints: 5,
    totalTests: 10,
    passed: 8,
    failed: 2,
    skipped: 0,
    duration: 1500,
    startTime: Date.now(),
    testResults: [
      {
        status: 'pass',
        description: 'Test 1',
        endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
        type: 'success',
        expectedStatus: 200,
        actualStatus: 200,
        duration: 100,
        request: { method: 'GET', path: '/pets', headers: {} },
        response: { data: { id: 1 }, headers: {} },
        errors: [],
        schemaValidation: { passed: true, errors: [] }
      }
    ],
    endpointCoverage: {
      total: 5,
      tested: 1,
      notTested: [],
      details: [
        { endpoint: { method: 'GET', path: '/pets' }, method: 'GET', path: '/pets', status: 'pass', testsPassed: 1, testsFailed: 0, testsTotal: 1 }
      ]
    }
  };

  const html = reporter.generateHTMLReport(mockResults);
  assertIncludes(html, '<!DOCTYPE html>', 'Should be valid HTML');
  assertIncludes(html, 'API Contract Test Report', 'Should have title');
  assertIncludes(html, 'endpoint-panel', 'Should have endpoint panels');
  assertIncludes(html, 'filter-btn', 'Should have filter buttons');
  assertIncludes(html, 'toggleTestDetails', 'Should have toggle function');
  assertIncludes(html, 'filterTests', 'Should have filter function');
});

runTest('Reporter > generateJUnitXML has valid structure', () => {
  const mockResults = {
    apiInfo: { title: 'Test API', version: '1.0.0' },
    baseUrl: 'http://localhost:3000',
    totalEndpoints: 2,
    totalTests: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    duration: 1000,
    startTime: Date.now(),
    testResults: [
      {
        status: 'pass',
        description: 'Test 1',
        endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
        type: 'success',
        duration: 100,
        request: { method: 'GET', path: '/pets' },
        response: { data: {} }
      },
      {
        status: 'fail',
        description: 'Test 2',
        endpoint: { method: 'POST', path: '/pets', tags: ['pets'] },
        type: 'success',
        duration: 50,
        request: { method: 'POST', path: '/pets', body: {} },
        response: { data: { code: 400 } },
        errors: [{ type: 'status_mismatch', message: 'Status mismatch' }]
      }
    ]
  };

  const xml = reporter.generateJUnitXML(mockResults);
  assertIncludes(xml, '<?xml version="1.0"', 'Should have XML declaration');
  assertIncludes(xml, '<testsuites', 'Should have testsuites');
  assertIncludes(xml, '<testsuite', 'Should have testsuite');
  assertIncludes(xml, '<testcase', 'Should have testcase');
  assertIncludes(xml, '<failure', 'Should have failure element');
});

runTest('Reporter > writeReports produces all file types', () => {
  const outputDir = path.join(OUTPUT_DIR, 'reporter-test');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const mockResults = {
    apiInfo: { title: 'Test API', version: '1.0.0' },
    baseUrl: 'http://localhost:3000',
    totalEndpoints: 1,
    totalTests: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration: 100,
    startTime: Date.now(),
    testResults: [
      {
        status: 'pass',
        description: 'Test 1',
        endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
        type: 'success',
        expectedStatus: 200,
        actualStatus: 200,
        duration: 100,
        request: { method: 'GET', path: '/pets' },
        response: { data: [] },
        errors: [],
        schemaValidation: { passed: true, errors: [] }
      }
    ],
    endpointCoverage: {
      total: 1,
      tested: 1,
      notTested: [],
      details: [
        { endpoint: { method: 'GET', path: '/pets' }, method: 'GET', path: '/pets', status: 'pass', testsPassed: 1, testsFailed: 0, testsTotal: 1 }
      ]
    }
  };

  const reports = reporter.writeReports(mockResults, outputDir, {
    junit: true,
    markdown: true,
    json: true,
    html: true
  });

  assertEqual(reports.length, 4, 'Should generate 4 report files');
  
  const reportTypes = reports.map(r => r.type).sort();
  assert(reportTypes.includes('html'), 'Should have html report');
  assert(reportTypes.includes('junit'), 'Should have junit report');
  assert(reportTypes.includes('json'), 'Should have json report');
  assert(reportTypes.includes('markdown'), 'Should have markdown report');
  
  reports.forEach(r => {
    assert(fs.existsSync(r.path), `Report file should exist: ${r.path}`);
  });
});

runTest('Reporter > generateConsoleReport has summary', () => {
  const mockResults = {
    apiInfo: { title: 'Test API', version: '1.0.0' },
    baseUrl: 'http://localhost:3000',
    totalEndpoints: 2,
    totalTests: 5,
    passed: 4,
    failed: 1,
    skipped: 0,
    duration: 500,
    testResults: [],
    endpointCoverage: {
      tested: 2,
      details: []
    }
  };

  const consoleReport = reporter.generateConsoleReport(mockResults);
  assertIncludes(consoleReport, 'API CONTRACT TEST RESULTS', 'Should have title');
  assertIncludes(consoleReport, 'SUMMARY', 'Should have summary section');
  assertIncludes(consoleReport, 'Pass Rate', 'Should have pass rate');
});

runTest('Reporter > calculatePercentage works correctly', () => {
  assertEqual(reporter.calculatePercentage(50, 100), 50, '50/100 should be 50%');
  assertEqual(reporter.calculatePercentage(0, 100), 0, '0/100 should be 0%');
  assertEqual(reporter.calculatePercentage(100, 100), 100, '100/100 should be 100%');
  assertEqual(reporter.calculatePercentage(1, 0), 0, 'Division by zero should return 0');
});

runTest('Reporter > formatDuration works correctly', () => {
  assertIncludes(reporter.formatDuration(500), 'ms', 'Short duration should be in ms');
  assertIncludes(reporter.formatDuration(1500), 's', 'Longer duration should be in s');
});

runTest('Reporter > saveTestSuite saves JSON file', () => {
  const outputDir = path.join(OUTPUT_DIR, 'generated-tests');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const parsed = parser.parseOpenAPI(OPENAPI_FILE);
  const suite = testGenerator.generateAllTests(parsed);
  const savedPath = reporter.saveTestSuite(suite, outputDir);
  assert(fs.existsSync(savedPath), 'Saved test suite should exist');
  
  const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  assertEqual(saved.totalTests, suite.totalTests, 'Saved suite should match');
});

console.log('\n📋 Phase 7: Mock Server Integration Tests\n');

async function runIntegrationTests() {
  console.log('  (Starting mock server on port ' + MOCK_SERVER_PORT + '...)');
  await startMockServer();
  console.log('  (Mock server started)\n');

  await runAsyncTest('Integration > full test run against mock server (success path)', async () => {
    const parsed = parser.parseOpenAPI(OPENAPI_FILE);
    let testSuite = testGenerator.generateAllTests(parsed);
    
    const successTests = testSuite.testCases.filter(t => t.type === 'success');
    testSuite.testCases = successTests;
    testSuite.totalTests = successTests.length;
    
    const results = await testRunner.runAllTests(testSuite, MOCK_BASE_URL, {
      timeout: 5000
    });
    
    assert(results.totalTests > 0, 'Should have run tests');
    assert(results.passed > 0, 'Should have passing tests');
    assertEqual(results.passed + results.failed, results.totalTests, 'Pass + fail should equal total');
  });

  await runAsyncTest('Integration > not_found tests return 404', async () => {
    const parsed = parser.parseOpenAPI(OPENAPI_FILE);
    let testSuite = testGenerator.generateAllTests(parsed);
    
    const notFoundTests = testSuite.testCases.filter(t => t.type === 'not_found');
    testSuite.testCases = notFoundTests;
    testSuite.totalTests = notFoundTests.length;
    
    const results = await testRunner.runAllTests(testSuite, MOCK_BASE_URL, {
      timeout: 5000
    });
    
    assert(results.totalTests > 0, 'Should have not_found tests');
    assert(results.passed > 0, '404 tests should pass');
  });

  await runAsyncTest('Integration > missing_required_body tests return 400', async () => {
    const parsed = parser.parseOpenAPI(OPENAPI_FILE);
    let testSuite = testGenerator.generateAllTests(parsed);
    
    const missingBodyTests = testSuite.testCases.filter(t => t.type === 'missing_required_body');
    testSuite.testCases = missingBodyTests;
    testSuite.totalTests = missingBodyTests.length;
    
    const results = await testRunner.runAllTests(testSuite, MOCK_BASE_URL, {
      timeout: 5000
    });
    
    assert(results.totalTests > 0, 'Should have missing body tests');
    assert(results.passed > 0, 'Missing body tests should pass');
  });

  await runAsyncTest('Integration > invalid_body tests return 400', async () => {
    const parsed = parser.parseOpenAPI(OPENAPI_FILE);
    let testSuite = testGenerator.generateAllTests(parsed);
    
    const invalidBodyTests = testSuite.testCases.filter(t => t.type === 'invalid_body');
    testSuite.testCases = invalidBodyTests;
    testSuite.totalTests = invalidBodyTests.length;
    
    const results = await testRunner.runAllTests(testSuite, MOCK_BASE_URL, {
      timeout: 5000
    });
    
    assert(results.totalTests > 0, 'Should have invalid body tests');
  });

  await runAsyncTest('Integration > test with bearer auth', async () => {
    const axios = require('axios');
    const headers = auth.buildAuthHeaders({
      authType: 'bearer',
      authToken: 'admin-token-12345'
    });
    
    const response = await axios({
      method: 'head',
      url: MOCK_BASE_URL + '/admin/stats',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      validateStatus: () => true
    });
    
    assertEqual(response.status, 200, 'Authorized request should return 200');
  });

  await runAsyncTest('Integration > test with invalid bearer auth returns 401', async () => {
    const axios = require('axios');
    const headers = auth.buildAuthHeaders({
      authType: 'bearer',
      authToken: 'wrong-token'
    });
    
    const response = await axios({
      method: 'head',
      url: MOCK_BASE_URL + '/admin/stats',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      validateStatus: () => true
    });
    
    assertEqual(response.status, 401, 'Invalid token should return 401');
  });

  await runAsyncTest('Integration > test without auth returns 401', async () => {
    const axios = require('axios');
    
    const response = await axios({
      method: 'head',
      url: MOCK_BASE_URL + '/admin/stats',
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    });
    
    assertEqual(response.status, 401, 'No auth should return 401');
  });

  await runAsyncTest('Integration > isolated mode creates and cleans up resources', async () => {
    const parsed = parser.parseOpenAPI(OPENAPI_FILE);
    let testSuite = testGenerator.generateAllTests(parsed);
    
    const getPetTests = testSuite.testCases.filter(
      t => t.type === 'success' && t.endpoint.method === 'GET' && t.endpoint.path === '/pets/{petId}'
    );
    testSuite.testCases = getPetTests;
    testSuite.totalTests = getPetTests.length;
    testSuite.endpoints = parsed.endpoints;
    
    const results = await testRunner.runAllTests(testSuite, MOCK_BASE_URL, {
      timeout: 5000,
      isolated: true
    });
    
    assert(results.totalTests > 0, 'Should have run tests');
    assert(results.passed > 0, 'Isolated mode tests should pass');
  });

  await runAsyncTest('Integration > test run with plugin loaded', async () => {
    const parsed = parser.parseOpenAPI(OPENAPI_FILE);
    let testSuite = testGenerator.generateAllTests(parsed);
    
    const successTests = testSuite.testCases.filter(t => t.type === 'success').slice(0, 2);
    testSuite.testCases = successTests;
    testSuite.totalTests = successTests.length;
    
    const pluginDir = path.resolve(__dirname, '..', 'plugins');
    const results = await testRunner.runAllTests(testSuite, MOCK_BASE_URL, {
      timeout: 5000,
      plugins: [pluginDir]
    });
    
    assert(results.totalTests === 2, 'Should have run 2 tests');
  });

  await runAsyncTest('Integration > full run with reports (HTML + Markdown)', async () => {
    const parsed = parser.parseOpenAPI(OPENAPI_FILE);
    let testSuite = testGenerator.generateAllTests(parsed);
    
    const outputDir = path.join(OUTPUT_DIR, 'full-run-test');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const results = await testRunner.runAllTests(testSuite, MOCK_BASE_URL, {
      timeout: 5000
    });
    
    const reports = reporter.writeReports(results, outputDir, {
      junit: false,
      markdown: true,
      json: false,
      html: true
    });
    
    const hasMarkdown = reports.some(r => r.type === 'markdown');
    const hasHTML = reports.some(r => r.type === 'html');
    assert(hasMarkdown, 'Should have Markdown report');
    assert(hasHTML, 'Should have HTML report');
    
    const mdReport = reports.find(r => r.type === 'markdown');
    const mdContent = fs.readFileSync(mdReport.path, 'utf8');
    assertIncludes(mdContent, 'API Contract Test Report', 'Markdown report should have title');
    
    const htmlReport = reports.find(r => r.type === 'html');
    const htmlContent = fs.readFileSync(htmlReport.path, 'utf8');
    assertIncludes(htmlContent, '<!DOCTYPE html>', 'HTML report should be valid HTML');
  });

  console.log('  (Stopping mock server...)');
  await stopMockServer();
  console.log('  (Mock server stopped)');
}

async function generateRegressionReport() {
  console.log('\n📊 Generating Regression Test Report...\n');

  regressionResults.endTime = Date.now();
  regressionResults.duration = regressionResults.endTime - regressionResults.startTime;

  const outputDir = path.join(OUTPUT_DIR, 'regression-report');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const reportResults = {
    apiInfo: { title: 'API Contract Tester - Regression Suite', version: '1.0.0' },
    baseUrl: 'N/A (unit + integration tests)',
    totalEndpoints: regressionResults.totalTests,
    totalTests: regressionResults.totalTests,
    passed: regressionResults.passed,
    failed: regressionResults.failed,
    skipped: regressionResults.skipped,
    startTime: regressionResults.startTime,
    endTime: regressionResults.endTime,
    duration: regressionResults.duration,
    testResults: regressionResults.testResults.map(t => ({
      testId: t.name,
      description: t.name,
      endpoint: { method: 'TEST', path: t.category, tags: [t.category] },
      type: t.category,
      status: t.status,
      expectedStatus: null,
      actualStatus: null,
      errors: t.errors,
      duration: t.duration,
      request: null,
      response: null,
      schemaValidation: { passed: t.status === 'pass', errors: [] }
    })),
    endpointCoverage: {
      total: 1,
      tested: 1,
      notTested: [],
      details: [{
        endpoint: { method: 'REGRESSION', path: '/full-suite' },
        method: 'REGRESSION',
        path: '/full-suite',
        status: regressionResults.failed === 0 ? 'pass' : 'fail',
        testsPassed: regressionResults.passed,
        testsFailed: regressionResults.failed,
        testsTotal: regressionResults.totalTests
      }]
    }
  };

  const reports = reporter.writeReports(reportResults, outputDir, {
    junit: false,
    markdown: true,
    json: true,
    html: true
  });

  console.log('✅ Regression reports generated:');
  for (const report of reports) {
    console.log(`   • ${report.type.toUpperCase()}: ${report.path}`);
  }

  return reports;
}

async function main() {
  try {
    await runIntegrationTests();
    
    const reports = await generateRegressionReport();
    
    console.log('\n' + '═'.repeat(70));
    console.log('  Regression Test Summary');
    console.log('═'.repeat(70));
    console.log(`  Total Tests: ${regressionResults.totalTests}`);
    console.log(`  ✅ Passed:    ${regressionResults.passed}`);
    console.log(`  ❌ Failed:    ${regressionResults.failed}`);
    console.log(`  ⏭️  Skipped:   ${regressionResults.skipped}`);
    console.log(`  📈 Pass Rate: ${reporter.calculatePercentage(regressionResults.passed, regressionResults.totalTests)}%`);
    console.log(`  ⏱️  Duration:  ${reporter.formatDuration(regressionResults.duration)}`);
    console.log('═'.repeat(70) + '\n');

    if (regressionResults.failed > 0) {
      console.log('❌ Some regression tests failed!\n');
      const failed = regressionResults.testResults.filter(t => t.status === 'fail');
      for (const f of failed) {
        console.log(`  - ${f.name}`);
        for (const e of f.errors) {
          console.log(`    ${e.message}`);
        }
      }
      console.log('');
      process.exit(1);
    } else {
      console.log('🎉 All regression tests passed!\n');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    await stopMockServer();
    process.exit(1);
  }
}

main();
