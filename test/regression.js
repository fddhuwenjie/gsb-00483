#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const parser = require('../lib/parser');
const testGenerator = require('../lib/testGenerator');
const testRunner = require('../lib/testRunner');
const reporter = require('../lib/reporter');
const auth = require('../lib/auth');
const { createPluginManager } = require('../lib/pluginLoader');
const { createLifecycleManager } = require('../lib/lifecycle');

const OPENAPI_FILE = path.resolve(__dirname, '..', 'openapi.yaml');
const OPENAPI_V2_FILE = path.resolve(__dirname, '..', 'openapi-v2.yaml');
const MOCK_SERVER_PATH = path.resolve(__dirname, '..', 'mock-server.js');
const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');
const AUTH_CONFIG_FILE = path.resolve(__dirname, '..', 'auth-config.json');
const TEST_OUTPUT_DIR = path.resolve(__dirname, '..', 'test-reports', 'regression-test-output');
const TEST_REPORTS_DIR = path.resolve(__dirname, '..', 'test-reports', 'regression-reports');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      await result;
    }
    passed++;
    console.log(`  ✅ ${name}`);
    return true;
  } catch (error) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
    return false;
  }
}

async function suite(name, fn) {
  console.log(`\n📦 ${name}`);
  const result = fn();
  if (result && typeof result.then === 'function') {
    await result;
  }
}

function cleanTestOutput() {
  if (fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(TEST_REPORTS_DIR)) {
    fs.rmSync(TEST_REPORTS_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TEST_REPORTS_DIR, { recursive: true });
}

function startMockServer() {
  return new Promise((resolve, reject) => {
    const server = spawn('node', [MOCK_SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let serverReady = false;
    let startupError = null;

    const timeout = setTimeout(() => {
      if (!serverReady) {
        reject(new Error('Mock server startup timeout'));
      }
    }, 5000);

    server.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Mock Server is running')) {
        serverReady = true;
        clearTimeout(timeout);
        resolve(server);
      }
    });

    server.stderr.on('data', (data) => {
      startupError = data.toString();
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    server.on('exit', (code) => {
      if (!serverReady) {
        clearTimeout(timeout);
        reject(new Error(`Mock server exited with code ${code}: ${startupError}`));
      }
    });
  });
}

function stopMockServer(server) {
  return new Promise((resolve) => {
    server.kill('SIGTERM');
    server.on('close', resolve);
    setTimeout(resolve, 1000);
  });
}

async function runUnitTests() {
  await suite('1. Parser Module Tests', async () => {
    await test('parses openapi.yaml successfully', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      assert.ok(parsed, 'Parsed result should not be null');
      assert.strictEqual(parsed.info.title, 'Pet Store API');
      assert.strictEqual(parsed.info.version, '1.0.0');
      assert.ok(Array.isArray(parsed.endpoints), 'Endpoints should be an array');
      assert.ok(parsed.endpoints.length > 0, 'Should have endpoints');
    });

    await test('parses openapi-v2.yaml successfully', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_V2_FILE);
      assert.ok(parsed, 'Parsed result should not be null');
      assert.strictEqual(parsed.info.version, '2.0.0');
      assert.ok(Array.isArray(parsed.endpoints), 'Endpoints should be an array');
    });

    await test('extracts correct number of endpoints from v1', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      const expectedEndpoints = 12;
      assert.strictEqual(parsed.endpoints.length, expectedEndpoints,
        `Expected ${expectedEndpoints} endpoints, got ${parsed.endpoints.length}`);
    });

    await test('extracts endpoint methods and paths correctly', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      const getPets = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets');
      assert.ok(getPets, 'Should find GET /pets endpoint');
      assert.strictEqual(getPets.operationId, 'listPets');
      assert.ok(getPets.tags.includes('pets'));
    });

    await test('extracts path parameters correctly', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      const getPetById = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
      assert.ok(getPetById, 'Should find GET /pets/{petId} endpoint');
      assert.ok(getPetById.parameters.path.length > 0, 'Should have path parameters');
      const petIdParam = getPetById.parameters.path.find(p => p.name === 'petId');
      assert.ok(petIdParam, 'Should have petId parameter');
      assert.strictEqual(petIdParam.required, true);
      assert.strictEqual(petIdParam.schema.type, 'integer');
    });

    await test('extracts query parameters correctly', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      const listPets = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets');
      assert.ok(listPets, 'Should find GET /pets endpoint');
      const statusParam = listPets.parameters.query.find(p => p.name === 'status');
      assert.ok(statusParam, 'Should have status query parameter');
      assert.strictEqual(statusParam.required, false);
    });

    await test('extracts request body schema correctly', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      const addPet = parsed.endpoints.find(e => e.method === 'POST' && e.path === '/pets');
      assert.ok(addPet, 'Should find POST /pets endpoint');
      assert.ok(addPet.requestBody, 'Should have request body');
      assert.strictEqual(addPet.requestBody.required, true);
      const bodySchema = parser.getRequestBodySchema(addPet.requestBody);
      assert.ok(bodySchema, 'Should have body schema');
      assert.strictEqual(bodySchema.type, 'object');
    });

    await test('extracts response schemas correctly', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      const getPetById = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
      const successResponse = parser.getSuccessResponse(getPetById);
      assert.ok(successResponse, 'Should have success response');
      assert.strictEqual(successResponse.statusCode, 200);
      const responseSchema = parser.getResponseSchema(successResponse.response);
      assert.ok(responseSchema, 'Should have response schema');
    });

    await test('extracts error responses correctly', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      const getPetById = parsed.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
      const error404 = parser.getErrorResponse(getPetById, 404);
      assert.ok(error404, 'Should have 404 error response');
      assert.strictEqual(error404.statusCode, 404);
    });

    await test('extracts schemas dictionary correctly', () => {
      const parsed = parser.parseOpenAPI(OPENAPI_FILE);
      assert.ok(parsed.schemas, 'Should have schemas dictionary');
      assert.ok(parsed.schemas.Pet, 'Should have Pet schema');
      assert.ok(parsed.schemas.Error, 'Should have Error schema');
      assert.ok(parsed.schemas.Order, 'Should have Order schema');
      assert.ok(parsed.schemas.User, 'Should have User schema');
    });
  });

  await suite('2. Test Generator Module Tests', async () => {
    const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);

    await test('generates test suite with correct structure', () => {
      const testSuite = testGenerator.generateAllTests(parsedAPI);
      assert.ok(testSuite, 'Test suite should not be null');
      assert.strictEqual(testSuite.totalEndpoints, parsedAPI.endpoints.length);
      assert.ok(Array.isArray(testSuite.testCases), 'Test cases should be an array');
      assert.strictEqual(testSuite.totalTests, testSuite.testCases.length);
      assert.ok(testSuite.apiInfo, 'Should have apiInfo');
      assert.ok(Array.isArray(testSuite.servers), 'Should have servers array');
    });

    await test('generates multiple test types per endpoint', () => {
      const testSuite = testGenerator.generateAllTests(parsedAPI);
      const testTypes = new Set(testSuite.testCases.map(t => t.type));
      assert.ok(testTypes.has('success'), 'Should have success tests');
      assert.ok(testTypes.has('not_found'), 'Should have not_found tests');
    });

    await test('generates success test cases correctly', () => {
      const getPetById = parsedAPI.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
      const tests = testGenerator.generateTestsForEndpoint(getPetById);
      const successTest = tests.find(t => t.type === 'success');
      assert.ok(successTest, 'Should have success test');
      assert.strictEqual(successTest.expectedStatus, 200);
      assert.ok(successTest.description.includes('should return 200'));
      assert.ok(successTest.request.pathParams.petId !== undefined, 'Should have petId path param');
    });

    await test('generates not_found test cases correctly', () => {
      const getPetById = parsedAPI.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
      const tests = testGenerator.generateTestsForEndpoint(getPetById);
      const notFoundTest = tests.find(t => t.type === 'not_found');
      assert.ok(notFoundTest, 'Should have not_found test');
      assert.strictEqual(notFoundTest.expectedStatus, 404);
      assert.ok(notFoundTest.description.includes('should return 404'));
    });

    await test('generates missing_required_body test for POST /pets', () => {
      const addPet = parsedAPI.endpoints.find(e => e.method === 'POST' && e.path === '/pets');
      const tests = testGenerator.generateTestsForEndpoint(addPet);
      const missingBodyTest = tests.find(t => t.type === 'missing_required_body');
      assert.ok(missingBodyTest, 'Should have missing_required_body test');
      assert.strictEqual(missingBodyTest.expectedStatus, 400);
      assert.strictEqual(missingBodyTest.request.body, null);
    });

    await test('generates invalid_body test for POST /pets', () => {
      const addPet = parsedAPI.endpoints.find(e => e.method === 'POST' && e.path === '/pets');
      const tests = testGenerator.generateTestsForEndpoint(addPet);
      const invalidBodyTest = tests.find(t => t.type === 'invalid_body');
      assert.ok(invalidBodyTest, 'Should have invalid_body test');
      assert.strictEqual(invalidBodyTest.expectedStatus, 400);
      assert.ok(invalidBodyTest.request.body !== null, 'Should have invalid body');
    });

    await test('skips uploadImage endpoint for success tests', () => {
      const testSuite = testGenerator.generateAllTests(parsedAPI);
      const uploadImageTests = testSuite.testCases.filter(t =>
        t.endpoint.path.includes('uploadImage') && t.type === 'success'
      );
      assert.strictEqual(uploadImageTests.length, 0, 'Should not generate success test for uploadImage');
    });

    await test('generates test cases with validation config', () => {
      const getPetById = parsedAPI.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
      const tests = testGenerator.generateTestsForEndpoint(getPetById);
      const successTest = tests.find(t => t.type === 'success');
      assert.ok(successTest.validation, 'Should have validation config');
      assert.strictEqual(successTest.validation.checkStatus, true);
      assert.strictEqual(successTest.validation.checkSchema, true);
      assert.strictEqual(successTest.validation.checkRequiredFields, true);
      assert.strictEqual(successTest.validation.checkTypes, true);
    });

    await test('generates expected schema for success tests', () => {
      const getPetById = parsedAPI.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
      const tests = testGenerator.generateTestsForEndpoint(getPetById);
      const successTest = tests.find(t => t.type === 'success');
      assert.ok(successTest.expectedSchema, 'Should have expected schema');
      assert.strictEqual(successTest.expectedSchema.type, 'object');
    });

    await test('substitutes path parameters correctly', () => {
      const getPetById = parsedAPI.endpoints.find(e => e.method === 'GET' && e.path === '/pets/{petId}');
      const tests = testGenerator.generateTestsForEndpoint(getPetById);
      const successTest = tests.find(t => t.type === 'success');
      assert.ok(!successTest.request.path.includes('{'), 'Path should not have placeholders');
      assert.ok(successTest.request.path.includes('/pets/'), 'Path should have /pets/ prefix');
    });
  });

  await suite('3. Filter Functionality Tests', async () => {
    const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
    const testSuite = testGenerator.generateAllTests(parsedAPI);

    function applyFilter(ts, pattern) {
      const filtered = { ...ts, testCases: [...ts.testCases] };
      const regex = new RegExp(pattern, 'i');
      filtered.testCases = filtered.testCases.filter(t =>
        regex.test(t.description) || regex.test(t.endpoint.path) || regex.test(t.endpoint.method)
      );
      filtered.totalTests = filtered.testCases.length;
      return filtered;
    }

    await test('filters tests by path pattern - /pets', () => {
      const filtered = applyFilter(testSuite, '/pets');
      assert.ok(filtered.totalTests > 0, 'Should have filtered tests');
      assert.ok(filtered.totalTests < testSuite.totalTests, 'Should have fewer tests than total');
      const allPets = filtered.testCases.every(t => t.endpoint.path.includes('/pets'));
      assert.ok(allPets, 'All filtered tests should have /pets in path');
    });

    await test('filters tests by path pattern - /orders', () => {
      const filtered = applyFilter(testSuite, '/orders');
      assert.ok(filtered.totalTests > 0, 'Should have filtered tests');
      const allOrders = filtered.testCases.every(t => t.endpoint.path.includes('/orders'));
      assert.ok(allOrders, 'All filtered tests should have /orders in path');
    });

    await test('filters tests by method - GET', () => {
      const filtered = applyFilter(testSuite, 'GET');
      assert.ok(filtered.totalTests > 0, 'Should have filtered tests');
      const allGet = filtered.testCases.every(t => t.endpoint.method === 'GET');
      assert.ok(allGet, 'All filtered tests should be GET method');
    });

    await test('filters tests by description pattern - success', () => {
      const filtered = applyFilter(testSuite, 'success');
      assert.ok(filtered.totalTests > 0, 'Should have filtered tests');
      const allSuccess = filtered.testCases.every(t => t.description.includes('success'));
      assert.ok(allSuccess, 'All filtered tests should have success in description');
    });

    await test('filters tests by description pattern - 404', () => {
      const filtered = applyFilter(testSuite, '404');
      assert.ok(filtered.totalTests > 0, 'Should have filtered tests');
      const all404 = filtered.testCases.every(t => t.description.includes('404'));
      assert.ok(all404, 'All filtered tests should have 404 in description');
    });

    await test('filter with no matches returns empty result', () => {
      const filtered = applyFilter(testSuite, 'nonexistent_pattern_xyz');
      assert.strictEqual(filtered.totalTests, 0, 'Should have zero tests');
      assert.strictEqual(filtered.testCases.length, 0, 'Should have empty test cases array');
    });

    await test('filter is case insensitive', () => {
      const filteredUpper = applyFilter(testSuite, 'PETS');
      const filteredLower = applyFilter(testSuite, 'pets');
      assert.strictEqual(filteredUpper.totalTests, filteredLower.totalTests,
        'Case insensitive filtering should return same count');
    });

    await test('filter with specific endpoint - GET /pets/{petId}', () => {
      const filtered = applyFilter(testSuite, 'get.*petId');
      assert.ok(filtered.totalTests > 0, 'Should have filtered tests');
      const hasPetById = filtered.testCases.some(t =>
        t.endpoint.method === 'GET' && t.endpoint.path.includes('petId')
      );
      assert.ok(hasPetById, 'Should have GET pet by ID tests');
    });

    await test('filter updates totalTests count correctly', () => {
      const filtered = applyFilter(testSuite, '/pets');
      assert.strictEqual(filtered.totalTests, filtered.testCases.length,
        'totalTests should match testCases.length');
    });

    await test('filter preserves test suite structure', () => {
      const filtered = applyFilter(testSuite, '/pets');
      assert.ok(filtered.apiInfo, 'Should preserve apiInfo');
      assert.ok(filtered.servers, 'Should preserve servers');
      assert.strictEqual(filtered.totalEndpoints, testSuite.totalEndpoints,
        'Should preserve totalEndpoints (not filtered)');
    });
  });

  await suite('4. Auth Module Tests', async () => {
    await test('buildAuthHeaders - bearer auth', () => {
      const headers = auth.buildAuthHeaders({
        authType: 'bearer',
        authToken: 'test-token-123'
      });
      assert.ok(headers['Authorization'], 'Should have Authorization header');
      assert.strictEqual(headers['Authorization'], 'Bearer test-token-123');
    });

    await test('buildAuthHeaders - basic auth', () => {
      const headers = auth.buildAuthHeaders({
        authType: 'basic',
        authUser: 'admin',
        authPass: 'secret'
      });
      assert.ok(headers['Authorization'], 'Should have Authorization header');
      const encoded = Buffer.from('admin:secret').toString('base64');
      assert.strictEqual(headers['Authorization'], `Basic ${encoded}`);
    });

    await test('buildAuthHeaders - apikey auth with default header', () => {
      const headers = auth.buildAuthHeaders({
        authType: 'apikey',
        authKey: 'my-api-key'
      });
      assert.ok(headers['X-API-Key'], 'Should have X-API-Key header');
      assert.strictEqual(headers['X-API-Key'], 'my-api-key');
    });

    await test('buildAuthHeaders - apikey auth with custom header', () => {
      const headers = auth.buildAuthHeaders({
        authType: 'apikey',
        authKey: 'my-api-key',
        authHeader: 'X-Custom-Key'
      });
      assert.ok(headers['X-Custom-Key'], 'Should have custom header');
      assert.strictEqual(headers['X-Custom-Key'], 'my-api-key');
    });

    await test('buildAuthHeaders - no auth type returns empty headers', () => {
      const headers = auth.buildAuthHeaders({});
      assert.deepStrictEqual(headers, {}, 'Should return empty headers object');
    });

    await test('buildAuthHeaders - bearer without token throws error', () => {
      assert.throws(() => {
        auth.buildAuthHeaders({ authType: 'bearer' });
      }, /Bearer auth requires --auth-token/);
    });

    await test('buildAuthHeaders - basic without user/pass throws error', () => {
      assert.throws(() => {
        auth.buildAuthHeaders({ authType: 'basic', authUser: 'admin' });
      }, /Basic auth requires --auth-user and --auth-pass/);
    });

    await test('buildAuthHeaders - apikey without key throws error', () => {
      assert.throws(() => {
        auth.buildAuthHeaders({ authType: 'apikey' });
      }, /API key auth requires --auth-key/);
    });

    await test('buildAuthHeaders - unknown auth type throws error', () => {
      assert.throws(() => {
        auth.buildAuthHeaders({ authType: 'unknown' });
      }, /Unknown auth type/);
    });

    await test('loadAuthConfig - loads auth config file correctly', () => {
      const config = auth.loadAuthConfig(AUTH_CONFIG_FILE);
      assert.ok(config, 'Should load config');
      assert.strictEqual(config.authType, 'bearer');
      assert.strictEqual(config.authToken, 'admin-token-12345');
    });

    await test('loadAuthConfig - throws on missing file', () => {
      assert.throws(() => {
        auth.loadAuthConfig('/nonexistent/path/config.json');
      }, /Auth config file not found/);
    });

    await test('mergeAuthOptions - CLI options override file config', () => {
      const merged = auth.mergeAuthOptions({
        authConfig: AUTH_CONFIG_FILE,
        authToken: 'override-token'
      });
      assert.strictEqual(merged.authType, 'bearer');
      assert.strictEqual(merged.authToken, 'override-token');
    });

    await test('mergeAuthOptions - no config file uses only CLI options', () => {
      const merged = auth.mergeAuthOptions({
        authType: 'basic',
        authUser: 'user',
        authPass: 'pass'
      });
      assert.strictEqual(merged.authType, 'basic');
      assert.strictEqual(merged.authUser, 'user');
      assert.strictEqual(merged.authPass, 'pass');
    });
  });

  await suite('5. Plugin Loader Tests', async () => {
    await test('creates plugin manager instance', () => {
      const pm = createPluginManager();
      assert.ok(pm, 'Should create plugin manager');
      assert.strictEqual(pm.getPluginCount(), 0, 'Should start with zero plugins');
    });

    await test('loads plugins from directory', () => {
      const pm = createPluginManager();
      const plugins = pm.loadPlugins(PLUGINS_DIR);
      assert.ok(Array.isArray(plugins), 'Should return array of plugins');
      assert.ok(pm.getPluginCount() > 0, 'Should have loaded at least one plugin');
    });

    await test('loaded plugin has correct name', () => {
      const pm = createPluginManager();
      pm.loadPlugins(PLUGINS_DIR);
      const names = pm.getPluginNames();
      assert.ok(names.includes('log-plugin'), 'Should have log-plugin');
    });

    await test('loaded plugin has lifecycle hooks', () => {
      const pm = createPluginManager();
      pm.loadPlugins(PLUGINS_DIR);
      const plugin = pm.plugins.find(p => p.name === 'log-plugin');
      assert.ok(plugin, 'Should find log-plugin');
      assert.strictEqual(typeof plugin.beforeAll, 'function');
      assert.strictEqual(typeof plugin.afterAll, 'function');
      assert.strictEqual(typeof plugin.beforeEach, 'function');
      assert.strictEqual(typeof plugin.afterEach, 'function');
    });

    await test('returns empty array for nonexistent directory', () => {
      const pm = createPluginManager();
      const plugins = pm.loadPlugins('/nonexistent/plugins/dir');
      assert.ok(Array.isArray(plugins), 'Should return array');
      assert.strictEqual(plugins.length, 0, 'Should return empty array');
      assert.strictEqual(pm.getPluginCount(), 0, 'Should have zero plugins');
    });

    await test('getPluginNames returns array of names', () => {
      const pm = createPluginManager();
      pm.loadPlugins(PLUGINS_DIR);
      const names = pm.getPluginNames();
      assert.ok(Array.isArray(names), 'Should return array');
      names.forEach(name => assert.strictEqual(typeof name, 'string'));
    });

    await test('beforeAll hook executes without error', async () => {
      const pm = createPluginManager();
      pm.loadPlugins(PLUGINS_DIR);
      const testSuite = { totalTests: 5, apiInfo: { title: 'Test API' } };
      await pm.beforeAll(testSuite);
      assert.ok(true, 'beforeAll should not throw');
    });

    await test('beforeEach hook returns test case', async () => {
      const pm = createPluginManager();
      pm.loadPlugins(PLUGINS_DIR);
      const testCase = { id: 'test-1', description: 'Test' };
      const result = await pm.beforeEach(testCase);
      assert.ok(result, 'Should return result');
      assert.strictEqual(result.id, 'test-1');
    });

    await test('afterEach hook executes without error', async () => {
      const pm = createPluginManager();
      pm.loadPlugins(PLUGINS_DIR);
      const testCase = { id: 'test-1' };
      const result = { status: 'pass', errors: [] };
      await pm.afterEach(testCase, result);
      assert.ok(true, 'afterEach should not throw');
    });

    await test('afterAll hook executes without error', async () => {
      const pm = createPluginManager();
      pm.loadPlugins(PLUGINS_DIR);
      const results = { passed: 5, failed: 0 };
      await pm.afterAll(results);
      assert.ok(true, 'afterAll should not throw');
    });
  });

  await suite('6. Lifecycle / Isolated Mode Tests', async () => {
    const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);

    await test('creates lifecycle manager instance', () => {
      const lcm = createLifecycleManager('http://localhost:3000', {
        isolated: false
      });
      assert.ok(lcm, 'Should create lifecycle manager');
      assert.strictEqual(lcm.isolated, false);
    });

    await test('non-isolated mode setup returns test case unchanged', async () => {
      const lcm = createLifecycleManager('http://localhost:3000', {
        isolated: false
      });
      const testCase = { id: 'test-1', type: 'success', endpoint: parsedAPI.endpoints[0] };
      const result = await lcm.setup(testCase);
      assert.deepStrictEqual(result.testCase, testCase);
      assert.deepStrictEqual(result.createdResources, []);
    });

    await test('non-isolated mode teardown does nothing', async () => {
      const lcm = createLifecycleManager('http://localhost:3000', {
        isolated: false
      });
      await lcm.teardown({}, {}, []);
      assert.ok(true, 'Teardown should not throw in non-isolated mode');
    });

    await test('isolated mode is disabled by default', () => {
      const lcm = createLifecycleManager('http://localhost:3000');
      assert.strictEqual(lcm.isolated, false);
    });

    await test('isolated mode can be enabled', () => {
      const lcm = createLifecycleManager('http://localhost:3000', {
        isolated: true
      });
      assert.strictEqual(lcm.isolated, true);
    });

    await test('getResourceType identifies pet resources', () => {
      const lcm = createLifecycleManager('http://localhost:3000');
      assert.strictEqual(lcm.getResourceType('/pets'), 'pet');
      assert.strictEqual(lcm.getResourceType('/pets/123'), 'pet');
    });

    await test('getResourceType identifies order resources', () => {
      const lcm = createLifecycleManager('http://localhost:3000');
      assert.strictEqual(lcm.getResourceType('/orders'), 'order');
      assert.strictEqual(lcm.getResourceType('/orders/123'), 'order');
    });

    await test('getResourceType identifies user resources', () => {
      const lcm = createLifecycleManager('http://localhost:3000');
      assert.strictEqual(lcm.getResourceType('/users'), 'user');
      assert.strictEqual(lcm.getResourceType('/users/john'), 'user');
    });

    await test('getCollectionPath extracts collection path', () => {
      const lcm = createLifecycleManager('http://localhost:3000');
      assert.strictEqual(lcm.getCollectionPath('/pets/123'), '/pets');
      assert.strictEqual(lcm.getCollectionPath('/orders/456'), '/orders');
      assert.strictEqual(lcm.getCollectionPath('/users/john'), '/users');
    });

    await test('getIdField returns correct id field', () => {
      const lcm = createLifecycleManager('http://localhost:3000');
      assert.strictEqual(lcm.getIdField('pet'), 'id');
      assert.strictEqual(lcm.getIdField('order'), 'id');
      assert.strictEqual(lcm.getIdField('user'), 'username');
    });

    await test('beforeAll and afterAll hooks exist', () => {
      const lcm = createLifecycleManager('http://localhost:3000');
      assert.strictEqual(typeof lcm.beforeAll, 'function');
      assert.strictEqual(typeof lcm.afterAll, 'function');
    });
  });

  await suite('7. Reporter Module Tests', async () => {
    const mockResults = {
      apiInfo: { title: 'Test API', version: '1.0.0' },
      baseUrl: 'http://localhost:3000',
      totalEndpoints: 3,
      totalTests: 10,
      passed: 8,
      failed: 2,
      skipped: 0,
      startTime: Date.now() - 5000,
      endTime: Date.now(),
      duration: 5000,
      testResults: [
        {
          testId: 'test-1',
          description: 'GET /pets - should return 200 on success',
          endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
          type: 'success',
          status: 'pass',
          expectedStatus: 200,
          actualStatus: 200,
          errors: [],
          duration: 100,
          request: { method: 'GET', path: '/pets' },
          response: { status: 200, data: [] },
          schemaValidation: { passed: true, errors: [] }
        },
        {
          testId: 'test-2',
          description: 'GET /pets/{petId} - should return 404 for non-existent resource',
          endpoint: { method: 'GET', path: '/pets/{petId}', tags: ['pets'] },
          type: 'not_found',
          status: 'fail',
          expectedStatus: 404,
          actualStatus: 500,
          errors: [{ type: 'status_mismatch', message: 'Expected 404, got 500' }],
          duration: 50,
          request: { method: 'GET', path: '/pets/999' },
          response: { status: 500, data: { error: 'Internal error' } },
          schemaValidation: { passed: false, errors: [{ message: 'test error' }] }
        }
      ],
      endpointCoverage: {
        total: 3,
        tested: 2,
        notTested: [{ method: 'DELETE', path: '/pets/{petId}', operationId: 'deletePet' }],
        details: [
          { endpoint: { method: 'GET', path: '/pets' }, method: 'GET', path: '/pets', status: 'pass', testsPassed: 1, testsFailed: 0, testsTotal: 1 },
          { endpoint: { method: 'GET', path: '/pets/{petId}' }, method: 'GET', path: '/pets/{petId}', status: 'fail', testsPassed: 0, testsFailed: 1, testsTotal: 1 }
        ]
      }
    };

    await test('generateMarkdownReport produces valid markdown', () => {
      const md = reporter.generateMarkdownReport(mockResults);
      assert.ok(typeof md === 'string', 'Should return string');
      assert.ok(md.startsWith('# API Contract Test Report'), 'Should start with h1 title');
      assert.ok(md.includes('## Summary'), 'Should have Summary section');
      assert.ok(md.includes('## Endpoint Coverage'), 'Should have Endpoint Coverage section');
      assert.ok(md.includes('## Test Results'), 'Should have Test Results section');
    });

    await test('generateMarkdownReport includes summary stats', () => {
      const md = reporter.generateMarkdownReport(mockResults);
      assert.ok(md.includes('Total Tests'), 'Should include total tests');
      assert.ok(md.includes('Passed'), 'Should include passed count');
      assert.ok(md.includes('Failed'), 'Should include failed count');
      assert.ok(md.includes('Pass Rate'), 'Should include pass rate');
    });

    await test('generateMarkdownReport includes failed tests section', () => {
      const md = reporter.generateMarkdownReport(mockResults);
      assert.ok(md.includes('Failed Tests'), 'Should have failed tests section');
      assert.ok(md.includes('status_mismatch'), 'Should include error details');
    });

    await test('generateMarkdownReport includes passed tests section', () => {
      const md = reporter.generateMarkdownReport(mockResults);
      assert.ok(md.includes('Passed Tests'), 'Should have passed tests section');
    });

    await test('generateMarkdownReport includes schema validation section', () => {
      const md = reporter.generateMarkdownReport(mockResults);
      assert.ok(md.includes('Schema Validation Details'), 'Should have schema validation section');
    });

    await test('generateHTMLReport produces valid HTML', () => {
      const html = reporter.generateHTMLReport(mockResults);
      assert.ok(typeof html === 'string', 'Should return string');
      assert.ok(html.startsWith('<!DOCTYPE html>'), 'Should start with doctype');
      assert.ok(html.includes('<html'), 'Should have html tag');
      assert.ok(html.includes('</html>'), 'Should have closing html tag');
    });

    await test('generateHTMLReport includes title', () => {
      const html = reporter.generateHTMLReport(mockResults);
      assert.ok(html.includes('<title>API Contract Test Report</title>'), 'Should have title');
      assert.ok(html.includes('API Contract Test Report'), 'Should have h1 title');
    });

    await test('generateHTMLReport includes stats dashboard', () => {
      const html = reporter.generateHTMLReport(mockResults);
      assert.ok(html.includes('stat-grid'), 'Should have stat grid');
      assert.ok(html.includes('Total Tests'), 'Should have total tests');
      assert.ok(html.includes('Passed'), 'Should have passed');
      assert.ok(html.includes('Failed'), 'Should have failed');
    });

    await test('generateHTMLReport includes filter buttons', () => {
      const html = reporter.generateHTMLReport(mockResults);
      assert.ok(html.includes('filter-btn'), 'Should have filter buttons');
      assert.ok(html.includes('All'), 'Should have All filter');
      assert.ok(html.includes('Passed'), 'Should have Passed filter');
      assert.ok(html.includes('Failed'), 'Should have Failed filter');
    });

    await test('generateHTMLReport includes endpoint panels', () => {
      const html = reporter.generateHTMLReport(mockResults);
      assert.ok(html.includes('endpoint-panel'), 'Should have endpoint panels');
      assert.ok(html.includes('endpoint-path'), 'Should have endpoint path');
    });

    await test('generateHTMLReport includes JavaScript interactions', () => {
      const html = reporter.generateHTMLReport(mockResults);
      assert.ok(html.includes('<script>'), 'Should have script tag');
      assert.ok(html.includes('toggleEndpoint'), 'Should have toggleEndpoint function');
      assert.ok(html.includes('filterTests'), 'Should have filterTests function');
    });

    await test('generateHTMLReport includes pie chart SVG', () => {
      const html = reporter.generateHTMLReport(mockResults);
      assert.ok(html.includes('<svg'), 'Should have SVG chart');
    });

    await test('generateJUnitXML produces valid XML', () => {
      const xml = reporter.generateJUnitXML(mockResults);
      assert.ok(typeof xml === 'string', 'Should return string');
      assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'Should have XML declaration');
      assert.ok(xml.includes('<testsuites'), 'Should have testsuites element');
      assert.ok(xml.includes('<testsuite'), 'Should have testsuite element');
      assert.ok(xml.includes('<testcase'), 'Should have testcase elements');
    });

    await test('generateJUnitXML includes failure details', () => {
      const xml = reporter.generateJUnitXML(mockResults);
      assert.ok(xml.includes('<failure'), 'Should have failure elements');
      assert.ok(xml.includes('status_mismatch'), 'Should include error type');
    });

    await test('generateConsoleReport produces console output', () => {
      const report = reporter.generateConsoleReport(mockResults);
      assert.ok(typeof report === 'string', 'Should return string');
      assert.ok(report.includes('API CONTRACT TEST RESULTS'), 'Should have title');
      assert.ok(report.includes('SUMMARY'), 'Should have summary');
      assert.ok(report.includes('ENDPOINT STATUS'), 'Should have endpoint status');
    });

    await test('formatDuration formats milliseconds correctly', () => {
      assert.strictEqual(reporter.formatDuration(500), '500ms');
      assert.strictEqual(reporter.formatDuration(1500), '1.50s');
      assert.strictEqual(reporter.formatDuration(60000), '1m 0.00s');
    });

    await test('calculatePercentage calculates correctly', () => {
      assert.strictEqual(reporter.calculatePercentage(50, 100), 50);
      assert.strictEqual(reporter.calculatePercentage(0, 100), 0);
      assert.strictEqual(reporter.calculatePercentage(100, 100), 100);
      assert.strictEqual(reporter.calculatePercentage(5, 0), 0);
    });

    await test('writeReports writes all report formats to disk', () => {
      const outputDir = path.join(TEST_OUTPUT_DIR, 'reporter-test');
      const reports = reporter.writeReports(mockResults, outputDir, {
        junit: true,
        markdown: true,
        json: true,
        html: true
      });

      assert.ok(Array.isArray(reports), 'Should return array of reports');
      assert.strictEqual(reports.length, 4, 'Should have 4 report types');

      const reportTypes = reports.map(r => r.type);
      assert.ok(reportTypes.includes('junit'), 'Should have junit report');
      assert.ok(reportTypes.includes('markdown'), 'Should have markdown report');
      assert.ok(reportTypes.includes('json'), 'Should have json report');
      assert.ok(reportTypes.includes('html'), 'Should have html report');

      reports.forEach(report => {
        assert.ok(fs.existsSync(report.path), `Report file should exist: ${report.path}`);
        const content = fs.readFileSync(report.path, 'utf-8');
        assert.ok(content.length > 0, `Report file should not be empty: ${report.path}`);
      });
    });

    await test('writeReports can disable individual formats', () => {
      const outputDir = path.join(TEST_OUTPUT_DIR, 'reporter-test-disabled');
      const reports = reporter.writeReports(mockResults, outputDir, {
        junit: false,
        markdown: true,
        json: false,
        html: false
      });

      assert.strictEqual(reports.length, 1, 'Should have only 1 report type');
      assert.strictEqual(reports[0].type, 'markdown');
    });
  });

  await suite('8. Test Runner - Validation Logic Tests', async () => {
    await test('validateStatus passes when status matches', () => {
      const testCase = { expectedStatus: 200, validation: { checkStatus: true } };
      const result = { actualStatus: 200, errors: [] };
      testRunner.validateStatus(testCase, result);
      assert.strictEqual(result.errors.length, 0);
    });

    await test('validateStatus fails when status mismatches', () => {
      const testCase = { expectedStatus: 200, validation: { checkStatus: true } };
      const result = { actualStatus: 500, errors: [] };
      testRunner.validateStatus(testCase, result);
      assert.ok(result.errors.length > 0);
      assert.strictEqual(result.errors[0].type, 'status_mismatch');
    });

    await test('validateSchema passes with valid data', () => {
      const schema = {
        type: 'object',
        required: ['name', 'id'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' }
        }
      };
      const data = { id: 1, name: 'test' };
      const result = { errors: [], schemaValidation: { passed: false, errors: [] } };
      testRunner.validateSchema(schema, data, result);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.schemaValidation.passed, true);
    });

    await test('validateSchema fails with invalid data', () => {
      const schema = {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' }
        }
      };
      const data = { name: 123, age: 'not-a-number' };
      const result = { errors: [], schemaValidation: { passed: false, errors: [] } };
      testRunner.validateSchema(schema, data, result);
      assert.ok(result.errors.length > 0);
      assert.strictEqual(result.schemaValidation.passed, false);
    });

    await test('validateRequiredFields passes with all required fields', () => {
      const schema = {
        type: 'object',
        required: ['name', 'id'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' }
        }
      };
      const data = { id: 1, name: 'test' };
      const result = { errors: [] };
      testRunner.validateRequiredFields(schema, data, result);
      assert.strictEqual(result.errors.length, 0);
    });

    await test('validateRequiredFields fails with missing required field', () => {
      const schema = {
        type: 'object',
        required: ['name', 'id'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' }
        }
      };
      const data = { id: 1 };
      const result = { errors: [] };
      testRunner.validateRequiredFields(schema, data, result);
      assert.ok(result.errors.length > 0);
      assert.strictEqual(result.errors[0].type, 'missing_required_field');
    });

    await test('validateTypes passes with correct types', () => {
      const schema = {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } }
        }
      };
      const data = { id: 1, name: 'test', tags: ['a', 'b'] };
      const result = { errors: [] };
      testRunner.validateTypes(schema, data, result);
      assert.strictEqual(result.errors.length, 0);
    });

    await test('validateTypes fails with wrong types', () => {
      const schema = {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' }
        }
      };
      const data = { id: 'not-number', name: 123 };
      const result = { errors: [] };
      testRunner.validateTypes(schema, data, result);
      assert.ok(result.errors.length > 0);
      assert.strictEqual(result.errors[0].type, 'type_mismatch');
    });

    await test('buildUrl constructs URL without query params', () => {
      const url = testRunner.buildUrl('http://localhost:3000', '/pets', {});
      assert.strictEqual(url, 'http://localhost:3000/pets');
    });

    await test('buildUrl constructs URL with query params', () => {
      const url = testRunner.buildUrl('http://localhost:3000', '/pets', { status: 'available', limit: 10 });
      assert.ok(url.includes('?'));
      assert.ok(url.includes('status=available'));
      assert.ok(url.includes('limit=10'));
    });

    await test('buildUrl strips trailing slash from baseUrl', () => {
      const url = testRunner.buildUrl('http://localhost:3000/', '/pets', {});
      assert.strictEqual(url, 'http://localhost:3000/pets');
    });

    await test('buildUrl skips null/undefined query params', () => {
      const url = testRunner.buildUrl('http://localhost:3000', '/pets', {
        status: 'available',
        foo: null,
        bar: undefined
      });
      assert.ok(url.includes('status=available'));
      assert.ok(!url.includes('foo='));
      assert.ok(!url.includes('bar='));
    });

    await test('validateTestCase runs all validations', () => {
      const testCase = {
        expectedStatus: 200,
        expectedSchema: { type: 'object', properties: { name: { type: 'string' } } },
        validation: {
          checkStatus: true,
          checkSchema: false,
          checkRequiredFields: false,
          checkTypes: false
        }
      };
      const result = {
        actualStatus: 200,
        response: { data: { name: 'test' } },
        errors: [],
        schemaValidation: { passed: false, errors: [] }
      };
      testRunner.validateTestCase(testCase, result);
      assert.strictEqual(result.errors.length, 0);
    });
  });
}

async function runIntegrationTests() {
  let mockServer;

  try {
    console.log('\n🚀 Starting mock server for integration tests...');
    mockServer = await startMockServer();
    console.log('   ✅ Mock server started');

    await suite('9. Integration Tests - Mock Server (Success Path)', async () => {
      const baseUrl = 'http://localhost:3000';
      const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
      const testSuite = testGenerator.generateAllTests(parsedAPI);

      await test('success test for GET /pets passes', async () => {
        const listPetsTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/pets' && t.type === 'success'
        );
        assert.ok(listPetsTests.length > 0, 'Should have success test for GET /pets');

        const result = await testRunner.executeTestCase(listPetsTests[0], baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'pass', `Expected pass, got: ${result.errors.map(e => e.message).join(', ')}`);
        assert.strictEqual(result.actualStatus, 200);
        assert.ok(Array.isArray(result.response.data), 'Response data should be array');
      });

      await test('success test for GET /pets/{petId} passes', async () => {
        const getPetTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/pets/{petId}' && t.type === 'success'
        );
        assert.ok(getPetTests.length > 0, 'Should have success test for GET /pets/{petId}');

        const result = await testRunner.executeTestCase(getPetTests[0], baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'pass', `Expected pass, got: ${result.errors.map(e => e.message).join(', ')}`);
        assert.strictEqual(result.actualStatus, 200);
        assert.strictEqual(typeof result.response.data, 'object');
        assert.ok(result.response.data.id !== undefined);
      });

      await test('not_found test for GET /pets/{petId} passes', async () => {
        const notFoundTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/pets/{petId}' && t.type === 'not_found'
        );
        assert.ok(notFoundTests.length > 0, 'Should have not_found test');

        const result = await testRunner.executeTestCase(notFoundTests[0], baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'pass', `Expected pass, got: ${result.errors.map(e => e.message).join(', ')}`);
        assert.strictEqual(result.actualStatus, 404);
      });

      await test('success test for POST /pets passes', async () => {
        const postTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'POST' && t.endpoint.path === '/pets' && t.type === 'success'
        );
        assert.ok(postTests.length > 0, 'Should have success test for POST /pets');

        const result = await testRunner.executeTestCase(postTests[0], baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'pass', `Expected pass, got: ${result.errors.map(e => e.message).join(', ')}`);
        assert.strictEqual(result.actualStatus, 201);
      });

      await test('success test for GET /orders passes', async () => {
        const getOrdersTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/orders' && t.type === 'success'
        );
        assert.ok(getOrdersTests.length > 0, 'Should have success test for GET /orders');

        const result = await testRunner.executeTestCase(getOrdersTests[0], baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'pass', `Expected pass, got: ${result.errors.map(e => e.message).join(', ')}`);
        assert.strictEqual(result.actualStatus, 200);
        assert.ok(Array.isArray(result.response.data));
      });

      await test('success test for GET /users/{username} passes', async () => {
        const getUserTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/users/{username}' && t.type === 'success'
        );
        assert.ok(getUserTests.length > 0, 'Should have success test for GET /users/{username}');

        const result = await testRunner.executeTestCase(getUserTests[0], baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'pass', `Expected pass, got: ${result.errors.map(e => e.message).join(', ')}`);
        assert.strictEqual(result.actualStatus, 200);
      });

      await test('runAllTests executes full test suite', async () => {
        const results = await testRunner.runAllTests(testSuite, baseUrl, {
          timeout: 5000
        });
        assert.ok(results, 'Should have results');
        assert.strictEqual(results.totalTests, testSuite.totalTests);
        assert.ok(results.passed > 0, 'Should have some passing tests');
        assert.ok(Array.isArray(results.testResults), 'Should have test results array');
        assert.strictEqual(results.testResults.length, results.totalTests);
        assert.ok(results.duration > 0, 'Should have duration');
        assert.ok(results.endpointCoverage, 'Should have endpoint coverage');
      });

      await test('runAllTests with auth includes auth headers', async () => {
        const adminTest = {
          id: 'admin-stats-test',
          description: 'GET /admin/stats - should return 200 with auth',
          endpoint: {
            method: 'GET',
            path: '/admin/stats',
            tags: ['admin'],
            parameters: { path: [], query: [] }
          },
          type: 'success',
          expectedStatus: 200,
          request: {
            method: 'GET',
            path: '/admin/stats',
            pathParams: {},
            queryParams: {},
            headers: {},
            body: null
          },
          expectedSchema: null,
          validation: { checkStatus: true }
        };

        const smallSuite = {
          ...testSuite,
          testCases: [adminTest],
          totalTests: 1
        };

        const results = await testRunner.runAllTests(smallSuite, baseUrl, {
          timeout: 5000,
          authType: 'bearer',
          authToken: 'admin-token-12345'
        });
        assert.strictEqual(results.passed, 1, 'Auth test should pass');
        assert.strictEqual(results.testResults[0].actualStatus, 200);
      });

      await test('runAllTests without auth gets 401 on protected endpoint', async () => {
        const adminTest = {
          id: 'admin-stats-unauth',
          description: 'GET /admin/stats - should return 401 without auth',
          endpoint: {
            method: 'GET',
            path: '/admin/stats',
            tags: ['admin'],
            parameters: { path: [], query: [] }
          },
          type: 'success',
          expectedStatus: 401,
          request: {
            method: 'GET',
            path: '/admin/stats',
            pathParams: {},
            queryParams: {},
            headers: {},
            body: null
          },
          expectedSchema: null,
          validation: { checkStatus: true }
        };

        const smallSuite = {
          ...testSuite,
          testCases: [adminTest],
          totalTests: 1
        };

        const results = await testRunner.runAllTests(smallSuite, baseUrl, {
          timeout: 5000
        });
        assert.strictEqual(results.passed, 1, 'Should get 401 as expected');
        assert.strictEqual(results.testResults[0].actualStatus, 401);
      });
    });

    await suite('10. Integration Tests - Mock Server (Failure Path)', async () => {
      const baseUrl = 'http://localhost:3000';
      const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
      const testSuite = testGenerator.generateAllTests(parsedAPI);

      await test('missing_required_body test for POST /pets passes', async () => {
        const tests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'POST' && t.endpoint.path === '/pets' && t.type === 'missing_required_body'
        );
        assert.ok(tests.length > 0, 'Should have missing_required_body test');

        const result = await testRunner.executeTestCase(tests[0], baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'pass',
          `Expected pass (400 status), got ${result.actualStatus}: ${result.errors.map(e => e.message).join(', ')}`);
        assert.strictEqual(result.actualStatus, 400);
      });

      await test('invalid_parameter test returns 400', async () => {
        const getPetTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/pets/{petId}' && t.type === 'invalid_parameter'
        );
        if (getPetTests.length > 0) {
          const result = await testRunner.executeTestCase(getPetTests[0], baseUrl, { timeout: 5000 });
          assert.strictEqual(result.actualStatus, 400, `Expected 400, got ${result.actualStatus}`);
        }
      });

      await test('missing_required_query test type is generated for v2 API', async () => {
        const parsedV2 = parser.parseOpenAPI(OPENAPI_V2_FILE);
        const v2Suite = testGenerator.generateAllTests(parsedV2);
        const tests = v2Suite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/pets' && t.type === 'missing_required_query'
        );
        assert.ok(tests.length > 0, 'Should generate missing_required_query tests for v2 API');
        assert.strictEqual(tests[0].type, 'missing_required_query');
        assert.ok(tests[0].expectedStatus, 'Should have expected status');
      });

      await test('missing_required_query test executes without error', async () => {
        const parsedV2 = parser.parseOpenAPI(OPENAPI_V2_FILE);
        const v2Suite = testGenerator.generateAllTests(parsedV2);
        const tests = v2Suite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/pets' && t.type === 'missing_required_query'
        );
        if (tests.length > 0) {
          const result = await testRunner.executeTestCase(tests[0], baseUrl, { timeout: 5000 });
          assert.ok(result, 'Should have result');
          assert.ok(result.actualStatus !== undefined, 'Should have actual status');
          assert.ok(Array.isArray(result.errors), 'Should have errors array');
        }
      });

      await test('schema validation failure is detected', async () => {
        const badResponseTest = {
          id: 'schema-fail-test',
          description: 'Test schema validation failure',
          endpoint: {
            method: 'GET',
            path: '/pets/1',
            tags: ['pets'],
            parameters: { path: [], query: [] }
          },
          type: 'success',
          expectedStatus: 200,
          request: {
            method: 'GET',
            path: '/pets/1',
            pathParams: {},
            queryParams: {},
            headers: {},
            body: null
          },
          expectedSchema: {
            type: 'object',
            required: ['nonexistent_field'],
            properties: {
              nonexistent_field: { type: 'string' }
            }
          },
          validation: {
            checkStatus: true,
            checkSchema: true,
            checkRequiredFields: true,
            checkTypes: false
          }
        };

        const result = await testRunner.executeTestCase(badResponseTest, baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'fail', 'Should fail schema validation');
        assert.ok(result.errors.some(e => e.type === 'schema_validation' || e.type === 'missing_required_field'),
          'Should have schema or required field errors');
      });

      await test('request to nonexistent endpoint fails', async () => {
        const badTest = {
          id: 'bad-endpoint-test',
          description: 'Test nonexistent endpoint',
          endpoint: {
            method: 'GET',
            path: '/nonexistent',
            tags: [],
            parameters: { path: [], query: [] }
          },
          type: 'success',
          expectedStatus: 200,
          request: {
            method: 'GET',
            path: '/nonexistent',
            pathParams: {},
            queryParams: {},
            headers: {},
            body: null
          },
          expectedSchema: null,
          validation: { checkStatus: true }
        };

        const result = await testRunner.executeTestCase(badTest, baseUrl, { timeout: 5000 });
        assert.strictEqual(result.status, 'fail', 'Should fail with wrong status');
        assert.strictEqual(result.actualStatus, 404);
      });
    });

    await suite('11. Integration Tests - --isolated Mode', async () => {
      const baseUrl = 'http://localhost:3000';
      const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
      const testSuite = testGenerator.generateAllTests(parsedAPI);

      await test('isolated mode runs without errors', async () => {
        const results = await testRunner.runAllTests(testSuite, baseUrl, {
          timeout: 5000,
          isolated: true
        });
        assert.ok(results, 'Should have results');
        assert.strictEqual(results.totalTests, testSuite.totalTests);
        assert.ok(results.testResults.length > 0);
      });

      await test('isolated mode with GET success tests creates and cleans up resources', async () => {
        const getPetTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'GET' && t.endpoint.path === '/pets/{petId}' && t.type === 'success'
        );

        const smallSuite = {
          ...testSuite,
          testCases: getPetTests,
          totalTests: getPetTests.length,
          endpoints: parsedAPI.endpoints
        };

        const results = await testRunner.runAllTests(smallSuite, baseUrl, {
          timeout: 5000,
          isolated: true
        });
        assert.ok(results.passed > 0, 'Should have passing tests in isolated mode');
      });

      await test('isolated mode creates resources with POST for PUT tests', async () => {
        const putPetTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'PUT' && t.endpoint.path === '/pets/{petId}' && t.type === 'success'
        );

        const smallSuite = {
          ...testSuite,
          testCases: putPetTests,
          totalTests: putPetTests.length,
          endpoints: parsedAPI.endpoints
        };

        const results = await testRunner.runAllTests(smallSuite, baseUrl, {
          timeout: 5000,
          isolated: true
        });
        assert.strictEqual(results.failed, 0,
          `PUT test should pass in isolated mode: ${results.testResults.map(t => t.errors.map(e => e.message).join(', ')).join('; ')}`);
      });

      await test('isolated mode creates resources for DELETE tests', async () => {
        const deletePetTests = testSuite.testCases.filter(t =>
          t.endpoint.method === 'DELETE' && t.endpoint.path === '/pets/{petId}' && t.type === 'success'
        );

        const smallSuite = {
          ...testSuite,
          testCases: deletePetTests,
          totalTests: deletePetTests.length,
          endpoints: parsedAPI.endpoints
        };

        const results = await testRunner.runAllTests(smallSuite, baseUrl, {
          timeout: 5000,
          isolated: true
        });
        assert.strictEqual(results.failed, 0,
          `DELETE test should pass in isolated mode: ${results.testResults.map(t => t.errors.map(e => e.message).join(', ')).join('; ')}`);
      });
    });

    await suite('12. Integration Tests - Plugin Loading', async () => {
      const baseUrl = 'http://localhost:3000';
      const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
      const testSuite = testGenerator.generateAllTests(parsedAPI);

      await test('runAllTests with plugins loads successfully', async () => {
        const smallSuite = {
          ...testSuite,
          testCases: testSuite.testCases.slice(0, 2),
          totalTests: 2
        };

        const results = await testRunner.runAllTests(smallSuite, baseUrl, {
          timeout: 5000,
          plugins: [PLUGINS_DIR]
        });
        assert.ok(results, 'Should have results');
        assert.strictEqual(results.totalTests, 2);
      });

      await test('plugins directory can be a string (not array)', async () => {
        const smallSuite = {
          ...testSuite,
          testCases: testSuite.testCases.slice(0, 1),
          totalTests: 1
        };

        const results = await testRunner.runAllTests(smallSuite, baseUrl, {
          timeout: 5000,
          plugins: PLUGINS_DIR
        });
        assert.ok(results, 'Should have results');
        assert.strictEqual(results.totalTests, 1);
      });
    });

    await suite('13. Integration Tests - Full CLI Run with Reports', async () => {
      await test('CLI run command generates markdown and html reports', async () => {
        const outputDir = TEST_REPORTS_DIR;
        const cmd = `node ${path.resolve(__dirname, '..', 'apicontract.js')} run ${OPENAPI_FILE} --base-url http://localhost:3000 -o ${outputDir} --html --no-junit --no-json --filter "GET /pets - should return 200"`;

        try {
          execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
        } catch (e) {
        }

        const files = fs.readdirSync(outputDir);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        const htmlFiles = files.filter(f => f.endsWith('.html'));

        assert.ok(mdFiles.length > 0, 'Should generate markdown report');
        assert.ok(htmlFiles.length > 0, 'Should generate html report');

        mdFiles.forEach(f => {
          const content = fs.readFileSync(path.join(outputDir, f), 'utf-8');
          assert.ok(content.length > 0, `Markdown report ${f} should not be empty`);
          assert.ok(content.includes('# API Contract Test Report'), 'Should have report title');
        });

        htmlFiles.forEach(f => {
          const content = fs.readFileSync(path.join(outputDir, f), 'utf-8');
          assert.ok(content.length > 0, `HTML report ${f} should not be empty`);
          assert.ok(content.includes('<!DOCTYPE html>'), 'Should be valid HTML');
        });
      });

      await test('CLI run with --filter option filters correctly', async () => {
        const outputDir = path.join(TEST_REPORTS_DIR, 'filter-test');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const cmd = `node ${path.resolve(__dirname, '..', 'apicontract.js')} run ${OPENAPI_FILE} --base-url http://localhost:3000 -o ${outputDir} --filter "GET /pets" --no-junit --no-json`;

        try {
          execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
        } catch (e) {
        }

        const files = fs.readdirSync(outputDir);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        assert.ok(mdFiles.length > 0, 'Should generate report');

        const mdContent = fs.readFileSync(path.join(outputDir, mdFiles[0]), 'utf-8');
        assert.ok(mdContent.includes('GET /pets'), 'Should contain filtered endpoint tests');
      });

      await test('CLI run with --auth-config merges authentication', async () => {
        const outputDir = path.join(TEST_REPORTS_DIR, 'auth-config-test');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const cmd = `node ${path.resolve(__dirname, '..', 'apicontract.js')} run ${OPENAPI_FILE} --base-url http://localhost:3000 -o ${outputDir} --auth-config ${AUTH_CONFIG_FILE} --filter "GET /admin" --no-junit --no-json`;

        try {
          execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
        } catch (e) {
        }

        const files = fs.readdirSync(outputDir);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        assert.ok(mdFiles.length > 0, 'Should generate report with auth config');
      });

      await test('CLI generate command outputs test cases', async () => {
        const outputDir = path.join(TEST_OUTPUT_DIR, 'generated-tests');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const cmd = `node ${path.resolve(__dirname, '..', 'apicontract.js')} generate ${OPENAPI_FILE} -o ${outputDir}`;

        try {
          execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
        } catch (e) {
        }

        assert.ok(fs.existsSync(outputDir), 'Output directory should exist');
        const files = fs.readdirSync(outputDir);
        assert.ok(files.length > 0, 'Should generate test files');
      });

      await test('CLI list command lists test cases', async () => {
        const cmd = `node ${path.resolve(__dirname, '..', 'apicontract.js')} list ${OPENAPI_FILE}`;

        let output = '';
        try {
          output = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
        } catch (e) {
          output = e.stdout || e.message;
        }

        assert.ok(output.length > 0, 'Should output test case list');
        assert.ok(output.includes('GET') || output.includes('POST'), 'Should contain HTTP methods');
      });

      await test('CLI validate command validates OpenAPI spec', async () => {
        const cmd = `node ${path.resolve(__dirname, '..', 'apicontract.js')} validate ${OPENAPI_FILE}`;

        let output = '';
        try {
          output = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
        } catch (e) {
          output = e.stdout || e.message;
        }

        assert.ok(output.length > 0, 'Should output validation result');
      });

      await test('CLI diff command compares two specs', async () => {
        const cmd = `node ${path.resolve(__dirname, '..', 'apicontract.js')} diff ${OPENAPI_FILE} ${OPENAPI_V2_FILE}`;

        let output = '';
        try {
          output = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
        } catch (e) {
          output = e.stdout || e.message;
        }

        assert.ok(output.length > 0, 'Should output diff result');
      });
    });

  } finally {
    if (mockServer) {
      console.log('\n🛑 Stopping mock server...');
      await stopMockServer(mockServer);
      console.log('   ✅ Mock server stopped');
    }
  }
}

async function main() {
  console.log('🚀 Starting API Contract Tester Regression Tests');
  console.log('='.repeat(60));

  cleanTestOutput();

  console.log('\n🧪 Unit Tests');
  console.log('-'.repeat(60));

  await runUnitTests();

  console.log('\n🔗 Integration Tests');
  console.log('-'.repeat(60));

  await runIntegrationTests();

  console.log('\n' + '='.repeat(60));
  console.log(`📊 Test Summary: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});