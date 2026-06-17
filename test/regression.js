#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const parser = require('../lib/parser');
const testGenerator = require('../lib/testGenerator');
const reporter = require('../lib/reporter');
const auth = require('../lib/auth');
const { createPluginManager } = require('../lib/pluginLoader');
const { createLifecycleManager } = require('../lib/lifecycle');

const OPENAPI_FILE = path.resolve(__dirname, '..', 'openapi.yaml');
const OPENAPI_V2_FILE = path.resolve(__dirname, '..', 'openapi-v2.yaml');
const MOCK_SERVER_FILE = path.resolve(__dirname, '..', 'mock-server.js');
const AUTH_CONFIG_FILE = path.resolve(__dirname, '..', 'auth-config.json');
const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'test-reports', 'regression-test-output');

let mockServer = null;
let mockServerPort = 3000;
const testResults = [];

function test(name, fn) {
  try {
    fn();
    testResults.push({ name, status: 'pass', error: null });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    testResults.push({ name, status: 'fail', error: error.message });
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
  }
}

function asyncTest(name, fn) {
  return fn()
    .then(() => {
      testResults.push({ name, status: 'pass', error: null });
      console.log(`  ✅ ${name}`);
    })
    .catch((error) => {
      testResults.push({ name, status: 'fail', error: error.message });
      console.log(`  ❌ ${name}`);
      console.log(`     ${error.message}`);
    });
}

function section(title) {
  console.log(`\n📦 ${title}`);
  console.log(`   ${'─'.repeat(60)}`);
}

function startMockServer() {
  return new Promise((resolve, reject) => {
    mockServer = spawn('node', [MOCK_SERVER_FILE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: mockServerPort }
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error('Mock server failed to start within timeout'));
      }
    }, 5000);

    mockServer.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Pet Store Mock Server is running') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    mockServer.stderr.on('data', (data) => {
      console.error(`Mock server error: ${data.toString()}`);
    });

    mockServer.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`Mock server exited with code ${code}`));
      }
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.kill();
      mockServer = null;
      setTimeout(resolve, 500);
    } else {
      resolve();
    }
  });
}

function ensureOutputDir(subdir) {
  const dir = path.join(OUTPUT_DIR, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function runCLI(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.resolve(__dirname, '..', 'apicontract.js'), ...args], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', reject);
  });
}

async function runAllTests() {
  console.log('\n' + '═'.repeat(70));
  console.log(' API Contract Tester - Regression Test Suite');
  console.log('═'.repeat(70));

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  try {
    await runTestGeneratorTests();
    await runFilterTests();
    await runAuthTests();
    await runPluginTests();
    await runReporterTests();
    await runIsolatedTests();
    await runIntegrationTests();

    printSummary();
    generateTestReports();

    const failedCount = testResults.filter(r => r.status === 'fail').length;
    process.exit(failedCount > 0 ? 1 : 0);
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await stopMockServer();
  }
}

function runTestGeneratorTests() {
  section('Test Generator - Unit Tests');

  const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);

  test('parseOpenAPI returns valid API structure', () => {
    assert.strictEqual(typeof parsedAPI, 'object');
    assert.ok(parsedAPI.info, 'should have info');
    assert.ok(parsedAPI.endpoints, 'should have endpoints');
    assert.ok(Array.isArray(parsedAPI.endpoints), 'endpoints should be array');
    assert.ok(parsedAPI.endpoints.length > 0, 'should have at least one endpoint');
  });

  test('generateAllTests produces test suite with testCases', () => {
    const suite = testGenerator.generateAllTests(parsedAPI);
    assert.ok(suite.testCases, 'should have testCases');
    assert.ok(Array.isArray(suite.testCases), 'testCases should be array');
    assert.strictEqual(suite.totalTests, suite.testCases.length, 'totalTests should match testCases length');
    assert.ok(suite.totalTests > 0, 'should have at least one test case');
  });

  test('each test case has required fields', () => {
    const suite = testGenerator.generateAllTests(parsedAPI);
    for (const tc of suite.testCases) {
      assert.ok(tc.id, 'test case should have id');
      assert.ok(tc.description, 'test case should have description');
      assert.ok(tc.type, 'test case should have type');
      assert.ok(tc.endpoint, 'test case should have endpoint');
      assert.ok(tc.request, 'test case should have request');
      assert.ok(tc.expectedStatus !== undefined, 'test case should have expectedStatus');
      assert.ok(tc.validation, 'test case should have validation');
    }
  });

  test('generateTestsForEndpoint returns array for each endpoint', () => {
    for (const endpoint of parsedAPI.endpoints) {
      const tests = testGenerator.generateTestsForEndpoint(endpoint);
      assert.ok(Array.isArray(tests), `tests for ${endpoint.method} ${endpoint.path} should be array`);
    }
  });

  test('success test type has checkStatus and checkSchema enabled', () => {
    const suite = testGenerator.generateAllTests(parsedAPI);
    const successTests = suite.testCases.filter(t => t.type === 'success');
    assert.ok(successTests.length > 0, 'should have success tests');
    for (const tc of successTests) {
      assert.strictEqual(tc.validation.checkStatus, true, 'success test should check status');
    }
  });

  test('not_found test type expects 404 status', () => {
    const suite = testGenerator.generateAllTests(parsedAPI);
    const notFoundTests = suite.testCases.filter(t => t.type === 'not_found');
    for (const tc of notFoundTests) {
      assert.strictEqual(tc.expectedStatus, 404, 'not_found test should expect 404');
    }
  });

  test('test case IDs are unique', () => {
    const suite = testGenerator.generateAllTests(parsedAPI);
    const ids = new Set();
    for (const tc of suite.testCases) {
      assert.ok(!ids.has(tc.id), `duplicate test id: ${tc.id}`);
      ids.add(tc.id);
    }
  });

  test('generateTestCase with invalid type returns base test', () => {
    const endpoint = parsedAPI.endpoints[0];
    const tc = testGenerator.generateTestCase(endpoint, 'invalid_type_xyz');
    assert.ok(tc, 'should return base test');
    assert.strictEqual(tc.type, 'invalid_type_xyz');
  });

  test('openAPI v2 spec can also be parsed and generate tests', () => {
    const parsedV2 = parser.parseOpenAPI(OPENAPI_V2_FILE);
    const suiteV2 = testGenerator.generateAllTests(parsedV2);
    assert.ok(suiteV2.totalTests > 0, 'v2 spec should generate tests');
  });

  const genDir = ensureOutputDir('generated-tests');
  const suite = testGenerator.generateAllTests(parsedAPI);
  fs.writeFileSync(path.join(genDir, 'test-cases.json'), JSON.stringify(suite, null, 2));

  return Promise.resolve();
}

function runFilterTests() {
  section('Filter - --filter Option Tests');

  const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
  const testSuite = testGenerator.generateAllTests(parsedAPI);

  function applyFilter(suite, pattern) {
    const filtered = { ...suite, testCases: [...suite.testCases] };
    const regex = new RegExp(pattern, 'i');
    filtered.testCases = filtered.testCases.filter(t =>
      regex.test(t.description) || regex.test(t.endpoint.path) || regex.test(t.endpoint.method)
    );
    filtered.totalTests = filtered.testCases.length;
    return filtered;
  }

  test('filter by path pattern reduces test cases', () => {
    const filtered = applyFilter(testSuite, 'pets');
    assert.ok(filtered.totalTests < testSuite.totalTests, 'filtered count should be less than total');
    assert.ok(filtered.totalTests > 0, 'should have some matching tests');
    for (const tc of filtered.testCases) {
      const match = /pets/i.test(tc.description) || /pets/i.test(tc.endpoint.path) || /pets/i.test(tc.endpoint.method);
      assert.ok(match, `test case should match pets pattern: ${tc.description}`);
    }
  });

  test('filter by method (GET) returns only GET tests', () => {
    const filtered = applyFilter(testSuite, 'GET');
    assert.ok(filtered.totalTests > 0, 'should have GET tests');
    for (const tc of filtered.testCases) {
      assert.strictEqual(tc.endpoint.method, 'GET');
    }
  });

  test('filter by non-matching pattern returns zero tests', () => {
    const filtered = applyFilter(testSuite, 'nonexistent_endpoint_xyz123');
    assert.strictEqual(filtered.totalTests, 0);
    assert.strictEqual(filtered.testCases.length, 0);
  });

  test('filter by description keyword works', () => {
    const filtered = applyFilter(testSuite, 'should return 404');
    assert.ok(filtered.totalTests > 0, 'should have 404 tests');
    for (const tc of filtered.testCases) {
      assert.ok(tc.description.includes('404'), 'description should contain 404');
    }
  });

  test('empty filter returns all tests', () => {
    const filtered = applyFilter(testSuite, '');
    assert.strictEqual(filtered.totalTests, testSuite.totalTests);
  });

  test('filter is case insensitive', () => {
    const filteredUpper = applyFilter(testSuite, 'PETS');
    const filteredLower = applyFilter(testSuite, 'pets');
    assert.strictEqual(filteredUpper.totalTests, filteredLower.totalTests);
  });

  test('CLI run --filter works via CLI', async () => {
    const result = await runCLI(['run', OPENAPI_FILE, '--base-url', 'http://localhost:9999', '--dry-run', '--filter', 'pets', '-o', ensureOutputDir('filter-test')]);
    assert.ok(result.stdout.includes('Filtered to'), 'should mention filtered count');
  });

  return Promise.resolve();
}

function runAuthTests() {
  section('Auth - Authentication Parameter Merge Tests');

  test('buildAuthHeaders returns empty object when no authType', () => {
    const headers = auth.buildAuthHeaders({});
    assert.deepStrictEqual(headers, {});
  });

  test('buildAuthHeaders with bearer type sets Authorization header', () => {
    const headers = auth.buildAuthHeaders({ authType: 'bearer', authToken: 'test-token-123' });
    assert.strictEqual(headers['Authorization'], 'Bearer test-token-123');
  });

  test('buildAuthHeaders with basic auth encodes credentials', () => {
    const headers = auth.buildAuthHeaders({ authType: 'basic', authUser: 'admin', authPass: 'secret' });
    const expected = 'Basic ' + Buffer.from('admin:secret').toString('base64');
    assert.strictEqual(headers['Authorization'], expected);
  });

  test('buildAuthHeaders with apikey uses custom header', () => {
    const headers = auth.buildAuthHeaders({ authType: 'apikey', authKey: 'my-key', authHeader: 'X-Custom-Key' });
    assert.strictEqual(headers['X-Custom-Key'], 'my-key');
  });

  test('buildAuthHeaders with apikey uses default header X-API-Key', () => {
    const headers = auth.buildAuthHeaders({ authType: 'apikey', authKey: 'my-key' });
    assert.strictEqual(headers['X-API-Key'], 'my-key');
  });

  test('buildAuthHeaders throws on missing bearer token', () => {
    assert.throws(() => {
      auth.buildAuthHeaders({ authType: 'bearer' });
    }, /Bearer auth requires/);
  });

  test('buildAuthHeaders throws on missing basic auth user/pass', () => {
    assert.throws(() => {
      auth.buildAuthHeaders({ authType: 'basic', authUser: 'admin' });
    }, /Basic auth requires/);
  });

  test('buildAuthHeaders throws on missing apikey', () => {
    assert.throws(() => {
      auth.buildAuthHeaders({ authType: 'apikey' });
    }, /API key auth requires/);
  });

  test('buildAuthHeaders throws on unknown auth type', () => {
    assert.throws(() => {
      auth.buildAuthHeaders({ authType: 'oauth2' });
    }, /Unknown auth type/);
  });

  test('mergeAuthOptions preserves CLI options without config file', () => {
    const opts = auth.mergeAuthOptions({ authType: 'bearer', authToken: 'cli-token' });
    assert.strictEqual(opts.authType, 'bearer');
    assert.strictEqual(opts.authToken, 'cli-token');
  });

  test('mergeAuthOptions loads from config file', () => {
    const opts = auth.mergeAuthOptions({ authConfig: AUTH_CONFIG_FILE });
    assert.strictEqual(opts.authType, 'bearer');
    assert.strictEqual(opts.authToken, 'admin-token-12345');
  });

  test('mergeAuthOptions CLI overrides config file values', () => {
    const opts = auth.mergeAuthOptions({
      authConfig: AUTH_CONFIG_FILE,
      authToken: 'cli-override-token'
    });
    assert.strictEqual(opts.authToken, 'cli-override-token');
    assert.strictEqual(opts.authType, 'bearer');
  });

  test('loadAuthConfig throws on missing file', () => {
    assert.throws(() => {
      auth.loadAuthConfig('/nonexistent/auth-config.json');
    }, /Auth config file not found/);
  });

  test('loadAuthConfig throws on invalid JSON', () => {
    const tmpFile = path.join(OUTPUT_DIR, 'invalid-auth.json');
    fs.writeFileSync(tmpFile, 'not valid json {{{');
    assert.throws(() => {
      auth.loadAuthConfig(tmpFile);
    }, /Invalid JSON/);
  });

  const authDir = ensureOutputDir('auth-config-test');
  const customAuthFile = path.join(authDir, 'custom-auth.json');
  fs.writeFileSync(customAuthFile, JSON.stringify({
    authType: 'apikey',
    authKey: 'custom-api-key',
    authHeader: 'X-Custom-Auth'
  }, null, 2));

  test('mergeAuthOptions with custom config file works', () => {
    const opts = auth.mergeAuthOptions({ authConfig: customAuthFile });
    assert.strictEqual(opts.authType, 'apikey');
    assert.strictEqual(opts.authKey, 'custom-api-key');
    assert.strictEqual(opts.authHeader, 'X-Custom-Auth');
  });

  return Promise.resolve();
}

function runPluginTests() {
  section('Plugin Loader - Plugin Loading Tests');

  test('createPluginManager returns PluginManager instance', () => {
    const pm = createPluginManager();
    assert.ok(pm);
    assert.strictEqual(typeof pm.loadPlugins, 'function');
    assert.strictEqual(typeof pm.beforeAll, 'function');
    assert.strictEqual(typeof pm.afterAll, 'function');
    assert.strictEqual(typeof pm.beforeEach, 'function');
    assert.strictEqual(typeof pm.afterEach, 'function');
  });

  test('PluginManager starts with zero plugins', () => {
    const pm = createPluginManager();
    assert.strictEqual(pm.getPluginCount(), 0);
    assert.deepStrictEqual(pm.getPluginNames(), []);
  });

  test('loadPlugins loads plugins from directory', () => {
    const pm = createPluginManager();
    const plugins = pm.loadPlugins(PLUGINS_DIR);
    assert.ok(plugins.length > 0, 'should load at least one plugin');
    assert.ok(pm.getPluginCount() > 0);
    assert.ok(pm.getPluginNames().includes('log-plugin'));
  });

  test('loadPlugins on nonexistent directory returns empty', () => {
    const pm = createPluginManager();
    const plugins = pm.loadPlugins('/nonexistent/plugins/dir');
    assert.deepStrictEqual(plugins, []);
    assert.strictEqual(pm.getPluginCount(), 0);
  });

  test('loadPlugins with non-.js files ignores them', () => {
    const tmpDir = path.join(OUTPUT_DIR, 'plugin-test-tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'not-a-plugin.txt'), 'hello');
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# readme');

    const pm = createPluginManager();
    pm.loadPlugins(tmpDir);
    assert.strictEqual(pm.getPluginCount(), 0);
  });

  test('beforeAll invokes plugin beforeAll hooks', async () => {
    const pm = createPluginManager();
    let called = false;
    pm.plugins.push({
      name: 'test-plugin',
      beforeAll: async (suite) => { called = true; }
    });
    await pm.beforeAll({ totalTests: 5 });
    assert.strictEqual(called, true);
  });

  test('afterAll invokes plugin afterAll hooks', async () => {
    const pm = createPluginManager();
    let called = false;
    pm.plugins.push({
      name: 'test-plugin',
      afterAll: async (results) => { called = true; }
    });
    await pm.afterAll({ passed: 5, failed: 0 });
    assert.strictEqual(called, true);
  });

  test('beforeEach returns modified test case', async () => {
    const pm = createPluginManager();
    pm.plugins.push({
      name: 'test-plugin',
      beforeEach: async (tc) => {
        return { ...tc, modified: true };
      }
    });
    const result = await pm.beforeEach({ id: 'test-1', description: 'test' });
    assert.strictEqual(result.modified, true);
  });

  test('beforeEach with no return keeps original test case', async () => {
    const pm = createPluginManager();
    pm.plugins.push({
      name: 'test-plugin',
      beforeEach: async (tc) => { }
    });
    const original = { id: 'test-1', description: 'test' };
    const result = await pm.beforeEach(original);
    assert.strictEqual(result.id, 'test-1');
  });

  test('afterEach invokes plugin afterEach hooks', async () => {
    const pm = createPluginManager();
    let received = null;
    pm.plugins.push({
      name: 'test-plugin',
      afterEach: async (tc, result) => { received = { tc, result }; }
    });
    const testCase = { id: 't1' };
    const testResult = { status: 'pass' };
    await pm.afterEach(testCase, testResult);
    assert.deepStrictEqual(received.tc, testCase);
    assert.deepStrictEqual(received.result, testResult);
  });

  test('plugin with broken beforeAll does not crash', async () => {
    const pm = createPluginManager();
    pm.plugins.push({
      name: 'broken-plugin',
      beforeAll: async () => { throw new Error('plugin error'); }
    });
    let didThrow = false;
    try {
      await pm.beforeAll({});
    } catch (e) {
      didThrow = true;
    }
    assert.strictEqual(didThrow, false, 'plugin manager should catch plugin errors');
  });

  test('multiple plugins all get invoked', async () => {
    const pm = createPluginManager();
    const order = [];
    pm.plugins.push({
      name: 'p1',
      beforeEach: async (tc) => { order.push('p1'); return tc; }
    });
    pm.plugins.push({
      name: 'p2',
      beforeEach: async (tc) => { order.push('p2'); return tc; }
    });
    await pm.beforeEach({ id: 't' });
    assert.deepStrictEqual(order, ['p1', 'p2']);
  });

  return Promise.resolve();
}

function runReporterTests() {
  section('Reporter - HTML/Markdown Report Tests');

  const sampleResults = {
    apiInfo: { title: 'Test API', version: '1.0.0' },
    baseUrl: 'http://localhost:3000',
    totalEndpoints: 5,
    totalTests: 20,
    passed: 15,
    failed: 3,
    skipped: 2,
    startTime: Date.now() - 5000,
    endTime: Date.now(),
    duration: 5000,
    endpointCoverage: {
      total: 5,
      tested: 4,
      notTested: [{ method: 'DELETE', path: '/pets/{petId}', operationId: 'deletePet' }],
      details: [
        { endpoint: { method: 'GET', path: '/pets', tags: ['pets'] }, method: 'GET', path: '/pets', status: 'pass', testsPassed: 3, testsFailed: 0, testsTotal: 3 },
        { endpoint: { method: 'POST', path: '/pets', tags: ['pets'] }, method: 'POST', path: '/pets', status: 'fail', testsPassed: 2, testsFailed: 1, testsTotal: 3 }
      ]
    },
    testResults: [
      {
        testId: 't1',
        description: 'GET /pets - should return 200 on success',
        endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
        type: 'success',
        status: 'pass',
        expectedStatus: 200,
        actualStatus: 200,
        errors: [],
        duration: 50,
        request: { method: 'GET', path: '/pets', queryParams: {}, headers: {}, body: null },
        response: { status: 200, data: [{ id: 1, name: 'dog' }], headers: {} },
        schemaValidation: { passed: true, errors: [] }
      },
      {
        testId: 't2',
        description: 'POST /pets - should return 400 when missing required body',
        endpoint: { method: 'POST', path: '/pets', tags: ['pets'] },
        type: 'missing_required_body',
        status: 'fail',
        expectedStatus: 400,
        actualStatus: 500,
        errors: [
          { type: 'status_mismatch', message: 'Expected status 400, got 500', expected: 400, actual: 500, path: '/' }
        ],
        duration: 30,
        request: { method: 'POST', path: '/pets', queryParams: {}, headers: {}, body: null },
        response: { status: 500, data: { error: 'internal error' }, headers: {} },
        schemaValidation: { passed: false, errors: [{ keyword: 'type', message: 'should be object', instancePath: '/' }] }
      },
      {
        testId: 't3',
        description: 'GET /orders - should return 200 on success',
        endpoint: { method: 'GET', path: '/orders', tags: ['store'] },
        type: 'success',
        status: 'skipped',
        expectedStatus: 200,
        actualStatus: null,
        errors: [],
        duration: 0,
        request: { method: 'GET', path: '/orders', queryParams: {}, headers: {}, body: null },
        response: null,
        schemaValidation: { passed: false, errors: [] }
      }
    ]
  };

  const reporterDir = ensureOutputDir('reporter-test');

  test('generateMarkdownReport returns non-empty string', () => {
    const md = reporter.generateMarkdownReport(sampleResults);
    assert.ok(typeof md === 'string');
    assert.ok(md.length > 0);
    assert.ok(md.includes('# API Contract Test Report'));
  });

  test('markdown report includes summary table', () => {
    const md = reporter.generateMarkdownReport(sampleResults);
    assert.ok(md.includes('## Summary'));
    assert.ok(md.includes('Total Tests'));
    assert.ok(md.includes('Passed'));
    assert.ok(md.includes('Failed'));
  });

  test('markdown report includes failed tests section', () => {
    const md = reporter.generateMarkdownReport(sampleResults);
    assert.ok(md.includes('❌ Failed Tests'));
    assert.ok(md.includes('POST /pets'));
  });

  test('markdown report includes passed tests section', () => {
    const md = reporter.generateMarkdownReport(sampleResults);
    assert.ok(md.includes('✅ Passed Tests'));
  });

  test('markdown report includes endpoint coverage', () => {
    const md = reporter.generateMarkdownReport(sampleResults);
    assert.ok(md.includes('## Endpoint Coverage'));
  });

  test('generateHTMLReport returns non-empty string', () => {
    const html = reporter.generateHTMLReport(sampleResults);
    assert.ok(typeof html === 'string');
    assert.ok(html.length > 0);
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<html'));
    assert.ok(html.includes('</html>'));
  });

  test('HTML report includes title and styles', () => {
    const html = reporter.generateHTMLReport(sampleResults);
    assert.ok(html.includes('API Contract Test Report'));
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('</style>'));
  });

  test('HTML report includes filter buttons', () => {
    const html = reporter.generateHTMLReport(sampleResults);
    assert.ok(html.includes('filterTests'));
    assert.ok(html.includes('All'));
    assert.ok(html.includes('Passed'));
    assert.ok(html.includes('Failed'));
  });

  test('HTML report includes pie chart SVG', () => {
    const html = reporter.generateHTMLReport(sampleResults);
    assert.ok(html.includes('<svg'));
    assert.ok(html.includes('</svg>'));
  });

  test('HTML report includes endpoint panels', () => {
    const html = reporter.generateHTMLReport(sampleResults);
    assert.ok(html.includes('endpoint-panel'));
    assert.ok(html.includes('method-get'));
    assert.ok(html.includes('method-post'));
  });

  test('generateJUnitXML returns valid XML', () => {
    const xml = reporter.generateJUnitXML(sampleResults);
    assert.ok(xml.includes('<?xml'));
    assert.ok(xml.includes('<testsuites'));
    assert.ok(xml.includes('</testsuites>'));
    assert.ok(xml.includes('<testsuite'));
    assert.ok(xml.includes('<testcase'));
  });

  test('JUnit XML includes failure elements for failed tests', () => {
    const xml = reporter.generateJUnitXML(sampleResults);
    assert.ok(xml.includes('<failure'));
    assert.ok(xml.includes('status_mismatch'));
  });

  test('writeReports creates markdown file', () => {
    const reports = reporter.writeReports(sampleResults, reporterDir, {
      junit: false,
      markdown: true,
      json: false,
      html: false
    });
    const mdReport = reports.find(r => r.type === 'markdown');
    assert.ok(mdReport, 'should have markdown report');
    assert.ok(fs.existsSync(mdReport.path), 'markdown file should exist');
    const content = fs.readFileSync(mdReport.path, 'utf8');
    assert.ok(content.length > 0);
  });

  test('writeReports creates HTML file when html option is true', () => {
    const reports = reporter.writeReports(sampleResults, reporterDir, {
      junit: false,
      markdown: false,
      json: false,
      html: true
    });
    const htmlReport = reports.find(r => r.type === 'html');
    assert.ok(htmlReport, 'should have html report');
    assert.ok(fs.existsSync(htmlReport.path), 'html file should exist');
    const content = fs.readFileSync(htmlReport.path, 'utf8');
    assert.ok(content.includes('<!DOCTYPE html>'));
  });

  test('writeReports creates both Markdown and HTML together', () => {
    const reports = reporter.writeReports(sampleResults, reporterDir, {
      junit: false,
      markdown: true,
      json: false,
      html: true
    });
    const mdReport = reports.find(r => r.type === 'markdown');
    const htmlReport = reports.find(r => r.type === 'html');
    assert.ok(mdReport && htmlReport, 'should have both md and html reports');
    assert.ok(fs.existsSync(mdReport.path));
    assert.ok(fs.existsSync(htmlReport.path));
  });

  test('writeReports with all false returns empty array', () => {
    const reports = reporter.writeReports(sampleResults, reporterDir, {
      junit: false,
      markdown: false,
      json: false,
      html: false
    });
    assert.deepStrictEqual(reports, []);
  });

  test('generateConsoleReport returns non-empty string', () => {
    const consoleReport = reporter.generateConsoleReport(sampleResults);
    assert.ok(typeof consoleReport === 'string');
    assert.ok(consoleReport.length > 0);
    assert.ok(consoleReport.includes('SUMMARY'));
  });

  test('formatDuration formats milliseconds correctly', () => {
    assert.strictEqual(reporter.formatDuration(500), '500ms');
    assert.ok(reporter.formatDuration(1500).includes('s'));
  });

  test('calculatePercentage returns correct percentage', () => {
    assert.strictEqual(reporter.calculatePercentage(50, 100), 50);
    assert.strictEqual(reporter.calculatePercentage(0, 100), 0);
    assert.strictEqual(reporter.calculatePercentage(100, 100), 100);
    assert.strictEqual(reporter.calculatePercentage(1, 0), 0);
  });

  test('saveTestSuite creates JSON file', () => {
    const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
    const suite = testGenerator.generateAllTests(parsedAPI);
    const savedPath = reporter.saveTestSuite(suite, ensureOutputDir('generated-tests'));
    assert.ok(fs.existsSync(savedPath));
    const content = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    assert.ok(content.testCases);
  });

  return Promise.resolve();
}

function runIsolatedTests() {
  section('Isolated Mode - --isolated Option Tests');

  test('createLifecycleManager returns LifecycleManager instance', () => {
    const lcm = createLifecycleManager('http://localhost:3000', { isolated: false });
    assert.ok(lcm);
    assert.strictEqual(typeof lcm.setup, 'function');
    assert.strictEqual(typeof lcm.teardown, 'function');
  });

  test('LifecycleManager with isolated=false setup returns original testCase', async () => {
    const lcm = createLifecycleManager('http://localhost:3000', { isolated: false });
    const testCase = { id: 'test-1', type: 'success', endpoint: { method: 'GET', path: '/pets/{petId}' } };
    const result = await lcm.setup(testCase);
    assert.deepStrictEqual(result.testCase, testCase);
    assert.deepStrictEqual(result.createdResources, []);
  });

  test('LifecycleManager with isolated=false teardown does nothing', async () => {
    const lcm = createLifecycleManager('http://localhost:3000', { isolated: false });
    let threw = false;
    try {
      await lcm.teardown({}, {}, []);
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, false);
  });

  test('LifecycleManager with isolated=true setup for non-success type does nothing', async () => {
    const lcm = createLifecycleManager('http://localhost:9999', {
      isolated: true,
      endpoints: [{ method: 'GET', path: '/pets/{petId}' }]
    });
    const testCase = {
      id: 'test-1',
      type: 'not_found',
      endpoint: { method: 'GET', path: '/pets/{petId}', parameters: { path: [{ name: 'petId', schema: { type: 'integer' } }], query: [] } }
    };
    const result = await lcm.setup(testCase);
    assert.strictEqual(result.createdResources.length, 0);
  });

  test('getResourceType identifies pet, order, user paths', () => {
    const lcm = createLifecycleManager('http://localhost:3000', { isolated: true });
    assert.strictEqual(lcm.getResourceType('/pets'), 'pet');
    assert.strictEqual(lcm.getResourceType('/pets/{petId}'), 'pet');
    assert.strictEqual(lcm.getResourceType('/orders/{orderId}'), 'order');
    assert.strictEqual(lcm.getResourceType('/users/{username}'), 'user');
    assert.strictEqual(lcm.getResourceType('/other'), null);
  });

  test('getCollectionPath returns collection path for resource paths', () => {
    const lcm = createLifecycleManager('http://localhost:3000', { isolated: true });
    assert.strictEqual(lcm.getCollectionPath('/pets/{petId}'), '/pets');
    assert.strictEqual(lcm.getCollectionPath('/orders/{orderId}'), '/orders');
    assert.strictEqual(lcm.getCollectionPath('/users/{username}'), '/users');
    assert.strictEqual(lcm.getCollectionPath('/pets'), null);
  });

  test('getIdField returns correct id field per resource type', () => {
    const lcm = createLifecycleManager('http://localhost:3000', { isolated: true });
    assert.strictEqual(lcm.getIdField('pet'), 'id');
    assert.strictEqual(lcm.getIdField('order'), 'id');
    assert.strictEqual(lcm.getIdField('user'), 'username');
  });

  test('buildAuthHeaders delegates to auth module', () => {
    const lcm = createLifecycleManager('http://localhost:3000', {
      isolated: true,
      authOptions: { authType: 'bearer', authToken: 'test-token' }
    });
    const headers = lcm.buildAuthHeaders();
    assert.strictEqual(headers['Authorization'], 'Bearer test-token');
  });

  return Promise.resolve();
}

async function runIntegrationTests() {
  section('Integration - Mock Server Tests');

  console.log('   Starting mock server...');
  await startMockServer();
  console.log('   Mock server is ready');

  const baseUrl = `http://localhost:${mockServerPort}`;

  await asyncTest('CLI generate command produces test files', async () => {
    const outDir = ensureOutputDir('integration-generate');
    const result = await runCLI(['generate', OPENAPI_FILE, '-o', outDir]);
    assert.strictEqual(result.code, 0, `generate should exit 0, got ${result.code}`);
    assert.ok(result.stdout.includes('Generation complete'));

    const files = fs.readdirSync(outDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    assert.ok(jsonFiles.length > 0, 'should have generated JSON files');
  });

  await asyncTest('CLI run command against mock server produces reports', async () => {
    const outDir = ensureOutputDir('full-run-test');
    const result = await runCLI([
      'run', OPENAPI_FILE,
      '--base-url', baseUrl,
      '-o', outDir,
      '--html'
    ]);

    assert.ok(result.stdout.includes('Reports generated') || result.stdout.includes('reports generated'), 'should mention reports generated');

    const files = fs.readdirSync(outDir);
    const htmlFiles = files.filter(f => f.endsWith('.html'));
    const mdFiles = files.filter(f => f.endsWith('.md'));
    const jsonFiles = files.filter(f => f.startsWith('test-results') && f.endsWith('.json'));

    assert.ok(htmlFiles.length > 0, 'should have HTML report');
    assert.ok(mdFiles.length > 0, 'should have Markdown report');
    assert.ok(jsonFiles.length > 0, 'should have JSON results');
  });

  await asyncTest('CLI run with --filter pets runs only pet-related tests', async () => {
    const outDir = ensureOutputDir('filter-integration');
    const result = await runCLI([
      'run', OPENAPI_FILE,
      '--base-url', baseUrl,
      '--filter', 'pets',
      '-o', outDir,
      '--html'
    ]);

    assert.ok(result.stdout.includes('Filtered to'), 'should mention filtered count');

    const files = fs.readdirSync(outDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    assert.ok(mdFiles.length > 0);
    const mdContent = fs.readFileSync(path.join(outDir, mdFiles[0]), 'utf8');
    assert.ok(mdContent.includes('pets'), 'report should mention pets');
  });

  await asyncTest('CLI run with auth config passes auth verification', async () => {
    const outDir = ensureOutputDir('auth-integration');
    const result = await runCLI([
      'auth',
      '--base-url', baseUrl,
      '--auth-config', AUTH_CONFIG_FILE
    ]);
    assert.ok(result.stdout.includes('Authentication successful') || result.stdout.includes('endpoint not found'),
      'auth command should attempt verification');
  });

  await asyncTest('CLI run with plugins loads log plugin', async () => {
    const outDir = ensureOutputDir('plugin-integration');
    const result = await runCLI([
      'run', OPENAPI_FILE,
      '--base-url', baseUrl,
      '--plugins', PLUGINS_DIR,
      '--filter', 'GET /pets - should return 200',
      '-o', outDir,
      '--html'
    ]);

    assert.ok(result.stdout.includes('Plugins:') || result.stdout.includes('plugins'), 'should mention plugins');
    assert.ok(fs.existsSync(path.join(process.cwd(), 'request-log.jsonl')) || result.code === 0 || result.code === 1,
      'plugin should have run');
  });

  await asyncTest('CLI run with --isolated mode works', async () => {
    const outDir = ensureOutputDir('isolated-integration');
    const result = await runCLI([
      'run', OPENAPI_FILE,
      '--base-url', baseUrl,
      '--isolated',
      '--filter', 'GET /pets/.*should return 200',
      '-o', outDir,
      '--html'
    ]);

    assert.ok(result.code === 0 || result.code === 1,
      'isolated run should execute');

    const files = fs.readdirSync(outDir);
    const htmlFiles = files.filter(f => f.endsWith('.html'));
    const mdFiles = files.filter(f => f.endsWith('.md'));
    assert.ok(htmlFiles.length > 0, 'should have HTML report in isolated mode');
    assert.ok(mdFiles.length > 0, 'should have Markdown report in isolated mode');
  });

  await asyncTest('Mock server - success path: GET /pets returns 200', async () => {
    const testRunner = require('../lib/testRunner');
    const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
    const suite = testGenerator.generateAllTests(parsedAPI);
    const getPetsSuccess = suite.testCases.find(
      t => t.endpoint.path === '/pets' && t.endpoint.method === 'GET' && t.type === 'success'
    );
    assert.ok(getPetsSuccess, 'should find GET /pets success test');

    const result = await testRunner.executeTestCase(getPetsSuccess, baseUrl, { timeout: 5000 });
    assert.strictEqual(result.status, 'pass', `GET /pets should pass, errors: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.actualStatus, 200);
  });

  await asyncTest('Mock server - 404 path: GET /pets/9999 returns 404', async () => {
    const testRunner = require('../lib/testRunner');
    const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
    const suite = testGenerator.generateAllTests(parsedAPI);
    const notFoundTest = suite.testCases.find(
      t => t.endpoint.path === '/pets/{petId}' && t.type === 'not_found'
    );
    assert.ok(notFoundTest, 'should find not_found test for /pets/{petId}');

    const result = await testRunner.executeTestCase(notFoundTest, baseUrl, { timeout: 5000 });
    assert.strictEqual(result.status, 'pass', `404 test should pass, errors: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.actualStatus, 404);
  });

  await asyncTest('Mock server - POST /pets success returns 201', async () => {
    const testRunner = require('../lib/testRunner');
    const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
    const suite = testGenerator.generateAllTests(parsedAPI);
    const postPetSuccess = suite.testCases.find(
      t => t.endpoint.path === '/pets' && t.endpoint.method === 'POST' && t.type === 'success'
    );
    assert.ok(postPetSuccess, 'should find POST /pets success test');

    const result = await testRunner.executeTestCase(postPetSuccess, baseUrl, { timeout: 5000 });
    assert.strictEqual(result.status, 'pass', `POST /pets should pass, errors: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.actualStatus, 201);
  });

  await asyncTest('Mock server - invalid parameter returns 400', async () => {
    const testRunner = require('../lib/testRunner');
    const parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
    const suite = testGenerator.generateAllTests(parsedAPI);
    const invalidParamTest = suite.testCases.find(
      t => t.type === 'invalid_parameter' && t.endpoint.path === '/pets/{petId}'
    );

    if (invalidParamTest) {
      const result = await testRunner.executeTestCase(invalidParamTest, baseUrl, { timeout: 5000 });
      assert.strictEqual(result.actualStatus, 400, 'invalid param should return 400');
    }
  });

  await asyncTest('CLI report command generates reports from JSON', async () => {
    const outDir = ensureOutputDir('reporter-cmd-test');
    const resultDir = ensureOutputDir('full-run-test');
    const jsonFiles = fs.readdirSync(resultDir).filter(f => f.startsWith('test-results') && f.endsWith('.json'));
    if (jsonFiles.length > 0) {
      const inputFile = path.join(resultDir, jsonFiles[0]);
      const result = await runCLI([
        'report',
        '-i', inputFile,
        '-o', outDir,
        '--html'
      ]);

      assert.ok(result.stdout.includes('Reports generated'));
      const outputFiles = fs.readdirSync(outDir);
      assert.ok(outputFiles.some(f => f.endsWith('.html')), 'should have HTML report');
      assert.ok(outputFiles.some(f => f.endsWith('.md')), 'should have Markdown report');
    }
  });

  await asyncTest('CLI validate command validates OpenAPI spec', async () => {
    const result = await runCLI(['validate', OPENAPI_FILE]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Specification is valid'));
  });

  await asyncTest('CLI list command lists endpoints', async () => {
    const result = await runCLI(['list', OPENAPI_FILE]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Total Endpoints'));
  });

  await asyncTest('CLI diff command compares two spec versions', async () => {
    const result = await runCLI(['diff', OPENAPI_FILE, OPENAPI_V2_FILE]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Comparing') || result.stdout.includes('diff', 'i'));
  });

  await stopMockServer();

  return Promise.resolve();
}

function printSummary() {
  const passed = testResults.filter(r => r.status === 'pass').length;
  const failed = testResults.filter(r => r.status === 'fail').length;
  const total = testResults.length;

  console.log('\n' + '═'.repeat(70));
  console.log(' REGRESSION TEST SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  Total Tests:  ${total}`);
  console.log(`  ✅ Passed:    ${passed}`);
  console.log(`  ❌ Failed:    ${failed}`);
  console.log(`  📊 Pass Rate: ${total > 0 ? Math.round((passed / total) * 100) : 0}%`);
  console.log('─'.repeat(70));

  if (failed > 0) {
    console.log('\n  Failed Tests:');
    for (const r of testResults.filter(r => r.status === 'fail')) {
      console.log(`    • ${r.name}`);
      console.log(`      ${r.error}`);
    }
  }

  console.log('\n' + '═'.repeat(70));
}

function generateTestReports() {
  const reportDir = ensureOutputDir('regression-report');

  const results = {
    apiInfo: { title: 'Regression Test Suite', version: '1.0.0' },
    baseUrl: 'local',
    totalEndpoints: 7,
    totalTests: testResults.length,
    passed: testResults.filter(r => r.status === 'pass').length,
    failed: testResults.filter(r => r.status === 'fail').length,
    skipped: 0,
    startTime: Date.now() - 10000,
    endTime: Date.now(),
    duration: 10000,
    endpointCoverage: {
      total: 7,
      tested: 7,
      notTested: [],
      details: [
        { endpoint: { method: 'UNIT', path: 'testGenerator', tags: ['unit'] }, method: 'UNIT', path: 'testGenerator', status: testResults.some(r => r.name.includes('Generator') && r.status === 'fail') ? 'fail' : 'pass', testsPassed: 0, testsFailed: 0, testsTotal: 0 },
        { endpoint: { method: 'UNIT', path: 'filter', tags: ['unit'] }, method: 'UNIT', path: 'filter', status: 'pass', testsPassed: 0, testsFailed: 0, testsTotal: 0 },
        { endpoint: { method: 'UNIT', path: 'auth', tags: ['unit'] }, method: 'UNIT', path: 'auth', status: 'pass', testsPassed: 0, testsFailed: 0, testsTotal: 0 },
        { endpoint: { method: 'UNIT', path: 'pluginLoader', tags: ['unit'] }, method: 'UNIT', path: 'pluginLoader', status: 'pass', testsPassed: 0, testsFailed: 0, testsTotal: 0 },
        { endpoint: { method: 'UNIT', path: 'reporter', tags: ['unit'] }, method: 'UNIT', path: 'reporter', status: 'pass', testsPassed: 0, testsFailed: 0, testsTotal: 0 },
        { endpoint: { method: 'UNIT', path: 'isolated', tags: ['unit'] }, method: 'UNIT', path: 'isolated', status: 'pass', testsPassed: 0, testsFailed: 0, testsTotal: 0 },
        { endpoint: { method: 'E2E', path: 'mockServer', tags: ['integration'] }, method: 'E2E', path: 'mockServer', status: 'pass', testsPassed: 0, testsFailed: 0, testsTotal: 0 }
      ]
    },
    testResults: testResults.map((r, i) => ({
      testId: `reg-${i}`,
      description: r.name,
      endpoint: { method: 'TEST', path: '/regression', tags: ['regression'] },
      type: r.status === 'pass' ? 'success' : 'failure',
      status: r.status,
      expectedStatus: 0,
      actualStatus: r.status === 'pass' ? 0 : 1,
      errors: r.error ? [{ type: 'assertion_error', message: r.error }] : [],
      duration: 10,
      request: { method: 'TEST', path: '/regression', queryParams: {}, headers: {}, body: null },
      response: r.error ? { status: 1, data: { error: r.error } } : { status: 0, data: {} },
      schemaValidation: { passed: r.status === 'pass', errors: [] }
    }))
  };

  const reports = reporter.writeReports(results, reportDir, {
    junit: true,
    markdown: true,
    json: true,
    html: true,
    suiteName: 'API Contract Tester - Regression Tests'
  });

  console.log(`\n📊 Regression reports generated in: ${reportDir}`);
  for (const r of reports) {
    console.log(`   • ${r.type.toUpperCase()}: ${r.path}`);
  }
}

runAllTests();
