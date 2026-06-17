#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

const parser = require('../lib/parser');
const testGenerator = require('../lib/testGenerator');
const testRunner = require('../lib/testRunner');
const reporter = require('../lib/reporter');
const auth = require('../lib/auth');
const { createPluginManager } = require('../lib/pluginLoader');
const { createLifecycleManager } = require('../lib/lifecycle');

const BASE_URL = 'http://localhost:3000';
const OPENAPI_FILE = path.resolve(__dirname, '..', 'openapi.yaml');
const OPENAPI_V2_FILE = path.resolve(__dirname, '..', 'openapi-v2.yaml');
const REPORT_DIR = path.resolve(__dirname, '..', 'test-reports');
const PLUGIN_DIR = path.resolve(__dirname, '..', 'plugins');

const results = {
  total: 0,
  passed: 0,
  failed: 0,
  suites: [],
  startTime: Date.now(),
  endTime: null
};

function record(suiteName, testName, passed, error) {
  results.total++;
  if (passed) results.passed++;
  else results.failed++;

  let suite = results.suites.find(s => s.name === suiteName);
  if (!suite) {
    suite = { name: suiteName, tests: [] };
    results.suites.push(suite);
  }
  suite.tests.push({ name: testName, passed, error: error ? error.message : null });
}

function assertTest(fn, suiteName, testName) {
  try {
    fn();
    record(suiteName, testName, true);
    console.log(`  ✅ ${testName}`);
  } catch (e) {
    record(suiteName, testName, false, e);
    console.log(`  ❌ ${testName}`);
    console.log(`     ${e.message}`);
  }
}

async function assertAsync(fn, suiteName, testName) {
  try {
    await fn();
    record(suiteName, testName, true);
    console.log(`  ✅ ${testName}`);
  } catch (e) {
    record(suiteName, testName, false, e);
    console.log(`  ❌ ${testName}`);
    console.log(`     ${e.message}`);
  }
}

let mockServerProcess = null;

async function startMockServer() {
  return new Promise((resolve, reject) => {
    mockServerProcess = spawn('node', [path.resolve(__dirname, '..', 'mock-server.js')], {
      stdio: 'pipe',
      cwd: path.resolve(__dirname, '..')
    });

    let output = '';
    mockServerProcess.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('Pet Store Mock Server is running')) {
        resolve();
      }
    });

    mockServerProcess.stderr.on('data', (data) => {
      console.error('Mock server stderr:', data.toString());
    });

    setTimeout(() => {
      reject(new Error('Mock server failed to start within 10s'));
    }, 10000);
  });
}

function stopMockServer() {
  if (mockServerProcess) {
    mockServerProcess.kill('SIGTERM');
    mockServerProcess = null;
  }
}

async function waitForServer(url, maxRetries) {
  maxRetries = maxRetries || 20;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await axios.get(url, { timeout: 1000 });
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error('Server at ' + url + ' not reachable after ' + maxRetries + ' retries');
}

function runTestGeneratorSuite() {
  var suiteName = '测试用例生成';
  console.log('\n📦 ' + suiteName);

  var parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);

  assertTest(function() {
    assert.ok(parsedAPI.endpoints.length > 0, '应解析出端点');
  }, suiteName, 'OpenAPI 解析应返回端点列表');

  assertTest(function() {
    assert.strictEqual(parsedAPI.info.title, 'Pet Store API');
    assert.strictEqual(parsedAPI.info.version, '1.0.0');
  }, suiteName, '解析结果应包含正确的 API 信息');

  var testSuite = testGenerator.generateAllTests(parsedAPI);

  assertTest(function() {
    assert.ok(testSuite.totalTests > 0, '应生成测试用例');
    assert.ok(testSuite.testCases.length > 0, 'testCases 数组应非空');
    assert.strictEqual(testSuite.testCases.length, testSuite.totalTests);
  }, suiteName, 'generateAllTests 应生成非零测试用例');

  assertTest(function() {
    assert.strictEqual(testSuite.totalEndpoints, parsedAPI.endpoints.length);
  }, suiteName, 'totalEndpoints 应与解析端点数一致');

  assertTest(function() {
    var successTests = testSuite.testCases.filter(function(t) { return t.type === 'success'; });
    assert.ok(successTests.length > 0, '应包含 success 类型测试');
    for (var i = 0; i < successTests.length; i++) {
      var t = successTests[i];
      assert.ok(t.description, 'success 测试应有描述');
      assert.ok(t.expectedStatus >= 200 && t.expectedStatus < 300, 'success 测试期望状态码应为 2xx');
      assert.ok(t.request, 'success 测试应有 request 对象');
    }
  }, suiteName, 'success 类型测试应正确生成');

  assertTest(function() {
    var notFoundTests = testSuite.testCases.filter(function(t) { return t.type === 'not_found'; });
    assert.ok(notFoundTests.length > 0, '应包含 not_found 类型测试');
    for (var i = 0; i < notFoundTests.length; i++) {
      assert.strictEqual(notFoundTests[i].expectedStatus, 404, 'not_found 测试期望状态码应为 404');
    }
  }, suiteName, 'not_found 类型测试应正确生成');

  assertTest(function() {
    var invalidParamTests = testSuite.testCases.filter(function(t) { return t.type === 'invalid_parameter'; });
    for (var i = 0; i < invalidParamTests.length; i++) {
      var t = invalidParamTests[i];
      assert.strictEqual(t.expectedStatus, 400, 'invalid_parameter 测试期望状态码应为 400');
      assert.ok(t.validation.invalidParam, 'invalid_parameter 测试应标记 invalidParam');
    }
  }, suiteName, 'invalid_parameter 类型测试应正确生成');

  assertTest(function() {
    var missingBodyTests = testSuite.testCases.filter(function(t) { return t.type === 'missing_required_body'; });
    for (var i = 0; i < missingBodyTests.length; i++) {
      var t = missingBodyTests[i];
      assert.strictEqual(t.expectedStatus, 400);
      assert.strictEqual(t.request.body, null, 'missing_required_body 测试 body 应为 null');
    }
  }, suiteName, 'missing_required_body 类型测试应正确生成');

  assertTest(function() {
    var invalidBodyTests = testSuite.testCases.filter(function(t) { return t.type === 'invalid_body'; });
    for (var i = 0; i < invalidBodyTests.length; i++) {
      var t = invalidBodyTests[i];
      assert.strictEqual(t.expectedStatus, 400);
      assert.ok(t.request.body !== null, 'invalid_body 测试应有 body');
    }
  }, suiteName, 'invalid_body 类型测试应正确生成');

  assertTest(function() {
    var types = new Set(testSuite.testCases.map(function(t) { return t.type; }));
    assert.ok(types.has('success'), '应包含 success 类型');
  }, suiteName, '生成的测试应覆盖多种测试类型');

  assertTest(function() {
    for (var i = 0; i < testSuite.testCases.length; i++) {
      var tc = testSuite.testCases[i];
      assert.ok(tc.id, '每个测试应有 id');
      assert.ok(tc.description, '每个测试应有 description');
      assert.ok(tc.endpoint, '每个测试应有 endpoint');
      assert.ok(tc.request, '每个测试应有 request');
      assert.ok(tc.validation, '每个测试应有 validation');
    }
  }, suiteName, '每个测试用例应包含完整结构字段');

  assertTest(function() {
    var uploadTests = testSuite.testCases.filter(function(t) {
      return t.endpoint.path.includes('uploadImage') && t.type === 'success';
    });
    assert.strictEqual(uploadTests.length, 0, 'uploadImage 端点不应生成 success 测试');
  }, suiteName, 'uploadImage 端点应跳过 success 测试生成');

  return testSuite;
}

function runFilterSuite(testSuite) {
  var suiteName = '--filter 过滤';
  console.log('\n📦 ' + suiteName);

  var originalCount = testSuite.testCases.length;

  assertTest(function() {
    var pattern = new RegExp('pet', 'i');
    var filtered = testSuite.testCases.filter(function(t) {
      return pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method);
    });
    assert.ok(filtered.length > 0, 'pet 过滤应返回结果');
    assert.ok(filtered.length < originalCount, 'pet 过滤应减少测试数量');
    for (var i = 0; i < filtered.length; i++) {
      var matches = pattern.test(filtered[i].description) || pattern.test(filtered[i].endpoint.path) || pattern.test(filtered[i].endpoint.method);
      assert.ok(matches, '过滤结果应匹配 pet 模式');
    }
  }, suiteName, '按 "pet" 关键词过滤应只保留匹配测试');

  assertTest(function() {
    var pattern = new RegExp('order', 'i');
    var filtered = testSuite.testCases.filter(function(t) {
      return pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method);
    });
    assert.ok(filtered.length > 0, 'order 过滤应返回结果');
    for (var i = 0; i < filtered.length; i++) {
      var matches = pattern.test(filtered[i].description) || pattern.test(filtered[i].endpoint.path) || pattern.test(filtered[i].endpoint.method);
      assert.ok(matches, '过滤结果应匹配 order 模式');
    }
  }, suiteName, '按 "order" 关键词过滤应只保留匹配测试');

  assertTest(function() {
    var pattern = new RegExp('DELETE', 'i');
    var filtered = testSuite.testCases.filter(function(t) {
      return pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method);
    });
    assert.ok(filtered.length > 0, 'DELETE 方法过滤应返回结果');
    for (var i = 0; i < filtered.length; i++) {
      assert.strictEqual(filtered[i].endpoint.method, 'DELETE', '过滤结果应全部为 DELETE 方法');
    }
  }, suiteName, '按 HTTP 方法过滤应只保留匹配测试');

  assertTest(function() {
    var pattern = new RegExp('nonexistent_pattern_xyz', 'i');
    var filtered = testSuite.testCases.filter(function(t) {
      return pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method);
    });
    assert.strictEqual(filtered.length, 0, '不匹配的模式应返回空结果');
  }, suiteName, '不匹配的模式应返回空结果集');

  assertTest(function() {
    var pattern = new RegExp('.', 'i');
    var filtered = testSuite.testCases.filter(function(t) {
      return pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method);
    });
    assert.strictEqual(filtered.length, originalCount, '通配模式应保留所有测试');
  }, suiteName, '通配模式应保留全部测试');

  assertTest(function() {
    var pattern = new RegExp('pets', 'i');
    var filtered = testSuite.testCases.filter(function(t) {
      return pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method);
    });
    var petEndpoints = testSuite.testCases.filter(function(t) { return t.endpoint.path.includes('pets'); });
    assert.strictEqual(filtered.length, petEndpoints.length, '路径过滤应匹配对应端点数');
  }, suiteName, '路径过滤应正确匹配端点路径');
}

function runAuthSuite() {
  var suiteName = '认证参数合并';
  console.log('\n📦 ' + suiteName);

  assertTest(function() {
    var headers = auth.buildAuthHeaders({
      authType: 'bearer',
      authToken: 'test-token-123'
    });
    assert.strictEqual(headers['Authorization'], 'Bearer test-token-123');
  }, suiteName, 'bearer 认证应生成正确的 Authorization 头');

  assertTest(function() {
    var headers = auth.buildAuthHeaders({
      authType: 'basic',
      authUser: 'admin',
      authPass: 'secret'
    });
    var expected = 'Basic ' + Buffer.from('admin:secret').toString('base64');
    assert.strictEqual(headers['Authorization'], expected);
  }, suiteName, 'basic 认证应生成正确的 Base64 编码头');

  assertTest(function() {
    var headers = auth.buildAuthHeaders({
      authType: 'apikey',
      authKey: 'my-api-key-123'
    });
    assert.strictEqual(headers['X-API-Key'], 'my-api-key-123');
  }, suiteName, 'apikey 认证应使用默认 X-API-Key 头');

  assertTest(function() {
    var headers = auth.buildAuthHeaders({
      authType: 'apikey',
      authKey: 'my-key',
      authHeader: 'X-Custom-Auth'
    });
    assert.strictEqual(headers['X-Custom-Auth'], 'my-key');
    assert.strictEqual(headers['X-API-Key'], undefined);
  }, suiteName, 'apikey 认证应支持自定义头名称');

  assertTest(function() {
    var headers = auth.buildAuthHeaders({});
    assert.deepStrictEqual(headers, {});
  }, suiteName, '无 authType 时应返回空头');

  assertTest(function() {
    assert.throws(function() {
      auth.buildAuthHeaders({ authType: 'bearer' });
    }, /Bearer auth requires --auth-token/);
  }, suiteName, 'bearer 缺少 token 应抛出错误');

  assertTest(function() {
    assert.throws(function() {
      auth.buildAuthHeaders({ authType: 'basic', authUser: 'admin' });
    }, /Basic auth requires --auth-user and --auth-pass/);
  }, suiteName, 'basic 缺少密码应抛出错误');

  assertTest(function() {
    assert.throws(function() {
      auth.buildAuthHeaders({ authType: 'apikey' });
    }, /API key auth requires --auth-key/);
  }, suiteName, 'apikey 缺少 key 应抛出错误');

  assertTest(function() {
    assert.throws(function() {
      auth.buildAuthHeaders({ authType: 'unknown_type' });
    }, /Unknown auth type/);
  }, suiteName, '未知 authType 应抛出错误');

  assertTest(function() {
    var merged = auth.mergeAuthOptions({
      authConfig: path.resolve(__dirname, '..', 'auth-config.json')
    });
    assert.strictEqual(merged.authType, 'bearer');
    assert.strictEqual(merged.authToken, 'admin-token-12345');
  }, suiteName, 'mergeAuthOptions 应从配置文件加载认证信息');

  assertTest(function() {
    var merged = auth.mergeAuthOptions({
      authConfig: path.resolve(__dirname, '..', 'auth-config.json'),
      authToken: 'cli-override-token'
    });
    assert.strictEqual(merged.authType, 'bearer');
    assert.strictEqual(merged.authToken, 'cli-override-token');
  }, suiteName, 'CLI 参数应覆盖配置文件中的值');

  assertTest(function() {
    var merged = auth.mergeAuthOptions({
      authType: 'basic',
      authUser: 'test',
      authPass: 'pass'
    });
    assert.strictEqual(merged.authType, 'basic');
    assert.strictEqual(merged.authUser, 'test');
  }, suiteName, '无 authConfig 时应直接使用 CLI 参数');

  assertTest(function() {
    assert.throws(function() {
      auth.loadAuthConfig('/nonexistent/path/auth.json');
    }, /Auth config file not found/);
  }, suiteName, '不存在的配置文件应抛出错误');
}

function runPluginLoaderSuite() {
  var suiteName = '插件加载';
  console.log('\n📦 ' + suiteName);

  assertTest(function() {
    var pm = createPluginManager();
    assert.strictEqual(pm.getPluginCount(), 0);
    assert.deepStrictEqual(pm.getPluginNames(), []);
  }, suiteName, '新建 PluginManager 应无插件');

  assertTest(function() {
    var pm = createPluginManager();
    pm.loadPlugins(PLUGIN_DIR);
    assert.strictEqual(pm.getPluginCount(), 1, '应加载 1 个插件');
    assert.ok(pm.getPluginNames().includes('log-plugin'), '应包含 log-plugin');
  }, suiteName, '应从 plugins 目录加载 log-plugin');

  assertTest(function() {
    var pm = createPluginManager();
    pm.loadPlugins('/nonexistent/plugin/dir');
    assert.strictEqual(pm.getPluginCount(), 0);
  }, suiteName, '不存在的目录应不加载任何插件');

  var testPluginDir = path.resolve(__dirname, '_test_plugins');

  assertTest(function() {
    if (!fs.existsSync(testPluginDir)) {
      fs.mkdirSync(testPluginDir, { recursive: true });
    }
    var brokenPluginPath = path.join(testPluginDir, 'broken-plugin.js');
    fs.writeFileSync(brokenPluginPath, 'throw new Error("plugin load error");');

    var pm = createPluginManager();
    pm.loadPlugins(testPluginDir);
    assert.strictEqual(pm.getPluginCount(), 0, '加载失败的插件不应被注册');

    fs.unlinkSync(brokenPluginPath);
    try { fs.rmdirSync(testPluginDir); } catch (e) {}
  }, suiteName, '加载失败的插件应被跳过而不崩溃');

  assertTest(function() {
    if (!fs.existsSync(testPluginDir)) {
      fs.mkdirSync(testPluginDir, { recursive: true });
    }
    var customPluginPath = path.join(testPluginDir, 'custom-plugin.js');
    fs.writeFileSync(customPluginPath, [
      'module.exports = {',
      '  name: "custom-test-plugin",',
      '  beforeAll: async (suite) => {},',
      '  beforeEach: async (tc) => { return { ...tc, _customFlag: true }; },',
      '  afterEach: async (tc, result) => {},',
      '  afterAll: async (results) => {}',
      '};'
    ].join('\n'));

    var pm = createPluginManager();
    pm.loadPlugins(testPluginDir);
    assert.strictEqual(pm.getPluginCount(), 1);
    assert.ok(pm.getPluginNames().includes('custom-test-plugin'));

    fs.unlinkSync(customPluginPath);
    try { fs.rmdirSync(testPluginDir); } catch (e) {}
  }, suiteName, '应正确加载自定义插件并注册名称');
}

async function runPluginHooksSuite() {
  var suiteName = '插件生命周期钩子';
  console.log('\n📦 ' + suiteName);

  var testPluginDir = path.resolve(__dirname, '_test_plugins');
  if (!fs.existsSync(testPluginDir)) {
    fs.mkdirSync(testPluginDir, { recursive: true });
  }

  var hookLogPath = path.join(testPluginDir, 'hook-log.json');
  var hookPluginPath = path.join(testPluginDir, 'hook-plugin.js');
  fs.writeFileSync(hookPluginPath, [
    'const fs = require("fs");',
    'const path = require("path");',
    'const logPath = ' + JSON.stringify(hookLogPath) + ';',
    'function log(event) {',
    '  let logs = [];',
    '  try { logs = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch(e) {}',
    '  logs.push(event);',
    '  fs.writeFileSync(logPath, JSON.stringify(logs));',
    '}',
    'module.exports = {',
    '  name: "hook-plugin",',
    '  beforeAll: async (suite) => { log("beforeAll"); },',
    '  beforeEach: async (tc) => { log("beforeEach:" + tc.id); return tc; },',
    '  afterEach: async (tc, result) => { log("afterEach:" + tc.id + ":" + result.status); },',
    '  afterAll: async (results) => { log("afterAll"); }',
    '};'
  ].join('\n'));

  await assertAsync(async function() {
    var pm = createPluginManager();
    pm.loadPlugins(testPluginDir);

    if (fs.existsSync(hookLogPath)) fs.unlinkSync(hookLogPath);

    var parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
    var ts = testGenerator.generateAllTests(parsedAPI);
    var pattern = new RegExp('GET.*/pets$', 'i');
    ts.testCases = ts.testCases.filter(function(t) {
      return pattern.test(t.description) || (t.endpoint.method === 'GET' && t.endpoint.path === '/pets');
    });
    ts.totalTests = ts.testCases.length;

    if (ts.testCases.length === 0) {
      ts.testCases = [ts.testCases[0] || {
        id: 'fallback_test',
        type: 'success',
        description: 'Fallback GET /pets',
        endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
        expectedStatus: 200,
        request: { method: 'GET', path: '/pets', pathParams: {}, queryParams: {}, headers: {}, body: null },
        validation: { checkStatus: true }
      }];
      ts.totalTests = 1;
    }

    await pm.beforeAll(ts);

    for (var i = 0; i < ts.testCases.length; i++) {
      var tc = await pm.beforeEach(ts.testCases[i]);
      var result = { status: 'pass', duration: 10 };
      await pm.afterEach(tc, result);
    }

    await pm.afterAll({ passed: 1, failed: 0 });

    var hookLog = JSON.parse(fs.readFileSync(hookLogPath, 'utf8'));
    assert.ok(hookLog.includes('beforeAll'), '应记录 beforeAll 事件');
    assert.ok(hookLog.includes('afterAll'), '应记录 afterAll 事件');

    fs.unlinkSync(hookPluginPath);
    if (fs.existsSync(hookLogPath)) fs.unlinkSync(hookLogPath);
    try { fs.rmdirSync(testPluginDir); } catch (e) {}
  }, suiteName, '插件钩子应按 beforeAll → beforeEach → afterEach → afterAll 顺序执行');
}

async function runIsolatedSuite() {
  var suiteName = '--isolated 模式';
  console.log('\n📦 ' + suiteName);

  var parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
  var testSuite = testGenerator.generateAllTests(parsedAPI);

  await assertAsync(async function() {
    var results = await testRunner.runAllTests(testSuite, BASE_URL, {
      timeout: 10000,
      isolated: true,
      plugins: []
    });
    assert.ok(results, '应返回测试结果');
    assert.ok(results.totalTests > 0, '应有测试结果');
    assert.ok(typeof results.passed === 'number', '应有 passed 计数');
    assert.ok(typeof results.failed === 'number', '应有 failed 计数');
  }, suiteName, 'isolated 模式应完成完整测试运行');

  await assertAsync(async function() {
    var lifecycle = createLifecycleManager(BASE_URL, {
      isolated: true,
      timeout: 10000,
      authOptions: {},
      endpoints: parsedAPI.endpoints
    });
    assert.strictEqual(lifecycle.isolated, true, 'lifecycle 应标记为 isolated');
  }, suiteName, 'LifecycleManager 应正确设置 isolated 标志');

  await assertAsync(async function() {
    var lifecycle = createLifecycleManager(BASE_URL, {
      isolated: false,
      timeout: 10000,
      authOptions: {},
      endpoints: parsedAPI.endpoints
    });
    var tc = {
      id: 'test-1',
      type: 'success',
      endpoint: { method: 'GET', path: '/pets', parameters: { path: [], query: [] } },
      request: { method: 'GET', path: '/pets', pathParams: {}, queryParams: {} }
    };
    var result = await lifecycle.setup(tc);
    assert.deepStrictEqual(result.testCase, tc, '非 isolated 模式 setup 应原样返回');
    assert.deepStrictEqual(result.createdResources, [], '非 isolated 模式不应创建资源');
  }, suiteName, '非 isolated 模式 setup 应跳过资源创建');

  await assertAsync(async function() {
    var lifecycle = createLifecycleManager(BASE_URL, {
      isolated: true,
      timeout: 10000,
      authOptions: {},
      endpoints: parsedAPI.endpoints
    });
    var tc = {
      id: 'test-1',
      type: 'not_found',
      endpoint: { method: 'GET', path: '/pets/{petId}', parameters: { path: [{ name: 'petId', required: true, schema: { type: 'integer' } }], query: [] } },
      request: { method: 'GET', path: '/pets/99999', pathParams: { petId: 99999 }, queryParams: {} }
    };
    var result = await lifecycle.setup(tc);
    assert.deepStrictEqual(result.createdResources, [], '非 success 类型测试不应创建资源');
  }, suiteName, 'isolated 模式下非 success 类型测试不应创建资源');

  await assertAsync(async function() {
    var lifecycle = createLifecycleManager(BASE_URL, {
      isolated: true,
      timeout: 10000,
      authOptions: {},
      endpoints: parsedAPI.endpoints
    });
    var tc = {
      id: 'test-1',
      type: 'success',
      endpoint: { method: 'GET', path: '/pets/{petId}', parameters: { path: [{ name: 'petId', required: true, schema: { type: 'integer' } }], query: [] } },
      request: { method: 'GET', path: '/pets/1', pathParams: { petId: 1 }, queryParams: {} }
    };
    var result = await lifecycle.setup(tc);
    assert.ok(result.testCase, 'setup 应返回测试用例');
    if (result.createdResources.length > 0) {
      assert.ok(result.createdResources[0].id, '创建的资源应有 id');
    }
  }, suiteName, 'isolated 模式下 success GET 应尝试创建依赖资源');

  await assertAsync(async function() {
    var lifecycle = createLifecycleManager(BASE_URL, {
      isolated: true,
      timeout: 10000,
      authOptions: {},
      endpoints: parsedAPI.endpoints
    });
    var resources = [
      { path: '/pets', idField: 'id', id: 9999 },
      { path: '/orders', idField: 'id', id: 8888 }
    ];
    await lifecycle.teardown({}, {}, resources);
  }, suiteName, 'isolated 模式 teardown 应尝试清理资源');

  await assertAsync(async function() {
    var lifecycle = createLifecycleManager(BASE_URL, {
      isolated: false,
      timeout: 10000,
      authOptions: {},
      endpoints: parsedAPI.endpoints
    });
    await lifecycle.teardown({}, {}, [{ path: '/pets', id: 1 }]);
  }, suiteName, '非 isolated 模式 teardown 应跳过清理');
}

function runReporterSuite() {
  var suiteName = 'HTML/Markdown 报告产出';
  console.log('\n📦 ' + suiteName);

  var mockResults = {
    apiInfo: { title: 'Pet Store API', version: '1.0.0' },
    baseUrl: 'http://localhost:3000',
    totalEndpoints: 3,
    totalTests: 5,
    passed: 3,
    failed: 1,
    skipped: 1,
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    duration: 1000,
    endpointResults: {
      'GET /pets': {
        endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
        tests: [],
        passed: 1,
        failed: 0,
        status: 'pass'
      }
    },
    testResults: [
      {
        testId: 'get_pets_success',
        description: 'GET /pets - should return 200 on success',
        endpoint: { method: 'GET', path: '/pets', tags: ['pets'] },
        type: 'success',
        status: 'pass',
        expectedStatus: 200,
        actualStatus: 200,
        errors: [],
        warnings: [],
        request: { method: 'GET', path: '/pets', pathParams: {}, queryParams: {}, headers: {}, body: null },
        response: { status: 200, statusText: 'OK', data: [{ id: 1, name: 'doggie' }] },
        duration: 150,
        schemaValidation: { passed: true, errors: [] }
      },
      {
        testId: 'get_pets_not_found',
        description: 'GET /pets/{petId} - should return 404 for non-existent resource',
        endpoint: { method: 'GET', path: '/pets/{petId}', tags: ['pets'] },
        type: 'not_found',
        status: 'fail',
        expectedStatus: 404,
        actualStatus: 200,
        errors: [{ type: 'status_mismatch', message: 'Expected status 404, got 200', expected: 404, actual: 200 }],
        warnings: [],
        request: { method: 'GET', path: '/pets/99999', pathParams: { petId: 99999 }, queryParams: {}, headers: {}, body: null },
        response: { status: 200, statusText: 'OK', data: { id: 1, name: 'doggie' } },
        duration: 80,
        schemaValidation: { passed: true, errors: [] }
      },
      {
        testId: 'post_pets_success',
        description: 'POST /pets - should return 201 on success',
        endpoint: { method: 'POST', path: '/pets', tags: ['pets'] },
        type: 'success',
        status: 'pass',
        expectedStatus: 201,
        actualStatus: 201,
        errors: [],
        warnings: [],
        request: { method: 'POST', path: '/pets', pathParams: {}, queryParams: {}, headers: {}, body: { name: 'test' } },
        response: { status: 201, statusText: 'Created', data: { id: 10, name: 'test' } },
        duration: 200,
        schemaValidation: { passed: true, errors: [] }
      },
      {
        testId: 'get_orders_success',
        description: 'GET /orders - should return 200 on success',
        endpoint: { method: 'GET', path: '/orders', tags: ['orders'] },
        type: 'success',
        status: 'pass',
        expectedStatus: 200,
        actualStatus: 200,
        errors: [],
        warnings: [],
        request: { method: 'GET', path: '/orders', pathParams: {}, queryParams: {}, headers: {}, body: null },
        response: { status: 200, statusText: 'OK', data: [] },
        duration: 50,
        schemaValidation: { passed: true, errors: [] }
      },
      {
        testId: 'skipped_test',
        description: 'Skipped test case',
        endpoint: { method: 'GET', path: '/skip', tags: ['default'] },
        type: 'success',
        status: 'skipped',
        expectedStatus: 200,
        actualStatus: null,
        errors: [],
        warnings: [],
        request: { method: 'GET', path: '/skip', pathParams: {}, queryParams: {}, headers: {}, body: null },
        response: null,
        duration: 0,
        schemaValidation: { passed: false, errors: [] }
      }
    ],
    endpointCoverage: {
      total: 3,
      tested: 1,
      notTested: [{ method: 'POST', path: '/orders', operationId: 'placeOrder' }],
      details: [
        { endpoint: { method: 'GET', path: '/pets' }, method: 'GET', path: '/pets', status: 'pass', testsPassed: 1, testsFailed: 0, testsTotal: 1 }
      ]
    }
  };

  assertTest(function() {
    var md = reporter.generateMarkdownReport(mockResults);
    assert.ok(md.includes('# API Contract Test Report'), 'Markdown 应包含标题');
    assert.ok(md.includes('## Summary'), 'Markdown 应包含 Summary 节');
    assert.ok(md.includes('## Endpoint Coverage'), 'Markdown 应包含 Endpoint Coverage 节');
    assert.ok(md.includes('## Test Results'), 'Markdown 应包含 Test Results 节');
    assert.ok(md.includes('Pet Store API'), 'Markdown 应包含 API 名称');
    assert.ok(md.includes('3'), 'Markdown 应包含 passed 数');
    assert.ok(md.includes('1'), 'Markdown 应包含 failed 数');
  }, suiteName, 'generateMarkdownReport 应生成完整 Markdown 报告');

  assertTest(function() {
    var md = reporter.generateMarkdownReport(mockResults);
    assert.ok(md.includes('❌ Failed Tests'), 'Markdown 应包含失败测试节');
    assert.ok(md.includes('✅ Passed Tests'), 'Markdown 应包含通过测试节');
    assert.ok(md.includes('⏭️ Skipped Tests'), 'Markdown 应包含跳过测试节');
    assert.ok(md.includes('status_mismatch'), 'Markdown 失败测试应包含错误类型');
  }, suiteName, 'Markdown 报告应区分通过/失败/跳过测试');

  assertTest(function() {
    var md = reporter.generateMarkdownReport(mockResults);
    assert.ok(md.includes('## Schema Validation Details'), 'Markdown 应包含 Schema 验证节');
  }, suiteName, 'Markdown 报告应包含 Schema 验证详情节');

  assertTest(function() {
    var html = reporter.generateHTMLReport(mockResults);
    assert.ok(html.includes('<!DOCTYPE html>'), 'HTML 应包含 DOCTYPE');
    assert.ok(html.includes('<html'), 'HTML 应包含 html 标签');
    assert.ok(html.includes('</html>'), 'HTML 应包含闭合标签');
    assert.ok(html.includes('API Contract Test Report'), 'HTML 应包含报告标题');
    assert.ok(html.includes('Pet Store API'), 'HTML 应包含 API 名称');
  }, suiteName, 'generateHTMLReport 应生成完整 HTML 报告');

  assertTest(function() {
    var html = reporter.generateHTMLReport(mockResults);
    assert.ok(html.includes('endpoint-panel'), 'HTML 应包含端点面板');
    assert.ok(html.includes('test-item'), 'HTML 应包含测试项');
    assert.ok(html.includes('filterTests'), 'HTML 应包含过滤功能');
    assert.ok(html.includes('toggleEndpoint'), 'HTML 应包含展开/折叠功能');
  }, suiteName, 'HTML 报告应包含交互功能');

  assertTest(function() {
    var html = reporter.generateHTMLReport(mockResults);
    assert.ok(html.includes('method-get'), 'HTML 应包含 GET 方法样式');
    assert.ok(html.includes('method-post'), 'HTML 应包含 POST 方法样式');
    assert.ok(html.includes('pieChart') || html.includes('<svg'), 'HTML 应包含饼图');
  }, suiteName, 'HTML 报告应包含方法标签和统计图表');

  assertTest(function() {
    var xml = reporter.generateJUnitXML(mockResults);
    assert.ok(xml.includes('<?xml'), 'JUnit XML 应包含 XML 声明');
    assert.ok(xml.includes('<testsuites'), 'JUnit XML 应包含 testsuites 标签');
    assert.ok(xml.includes('<testsuite'), 'JUnit XML 应包含 testsuite 标签');
    assert.ok(xml.includes('<testcase'), 'JUnit XML 应包含 testcase 标签');
  }, suiteName, 'generateJUnitXML 应生成有效 JUnit XML');

  assertTest(function() {
    var consoleReport = reporter.generateConsoleReport(mockResults);
    assert.ok(consoleReport.includes('API CONTRACT TEST RESULTS'), '控制台报告应包含标题');
    assert.ok(consoleReport.includes('SUMMARY'), '控制台报告应包含摘要');
    assert.ok(consoleReport.includes('ENDPOINT STATUS'), '控制台报告应包含端点状态');
  }, suiteName, 'generateConsoleReport 应生成控制台报告');

  var testReportDir = path.join(REPORT_DIR, 'unit-test-reports');
  assertTest(function() {
    if (!fs.existsSync(testReportDir)) {
      fs.mkdirSync(testReportDir, { recursive: true });
    }
    var reports = reporter.writeReports(mockResults, testReportDir, {
      junit: true,
      markdown: true,
      json: true,
      html: true,
      suiteName: 'Regression Test Report'
    });

    assert.strictEqual(reports.length, 4, '应生成 4 种报告');

    var types = reports.map(function(r) { return r.type; });
    assert.ok(types.includes('junit'), '应包含 JUnit 报告');
    assert.ok(types.includes('markdown'), '应包含 Markdown 报告');
    assert.ok(types.includes('json'), '应包含 JSON 报告');
    assert.ok(types.includes('html'), '应包含 HTML 报告');

    for (var i = 0; i < reports.length; i++) {
      assert.ok(fs.existsSync(reports[i].path), '报告文件应存在: ' + reports[i].path);
    }
  }, suiteName, 'writeReports 应同时输出 Markdown 和 HTML 等多格式报告');

  assertTest(function() {
    var mdReport = null;
    var htmlReport = null;
    var files = fs.readdirSync(testReportDir);
    for (var i = 0; i < files.length; i++) {
      if (files[i].endsWith('.md')) mdReport = path.join(testReportDir, files[i]);
      if (files[i].endsWith('.html')) htmlReport = path.join(testReportDir, files[i]);
    }
    assert.ok(mdReport, '应存在 Markdown 报告文件');
    assert.ok(htmlReport, '应存在 HTML 报告文件');

    var mdContent = fs.readFileSync(mdReport, 'utf8');
    var htmlContent = fs.readFileSync(htmlReport, 'utf8');
    assert.ok(mdContent.length > 100, 'Markdown 报告应有实质内容');
    assert.ok(htmlContent.length > 100, 'HTML 报告应有实质内容');
  }, suiteName, '报告文件应包含实质内容');
}

async function runMockServerSuccessSuite() {
  var suiteName = 'Mock Server 成功路径';
  console.log('\n📦 ' + suiteName);

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/pets');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data), '应返回数组');
  }, suiteName, 'GET /pets 应返回 200 和宠物列表');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/pets/1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.id, 1);
    assert.ok(res.data.name, '宠物应有 name');
  }, suiteName, 'GET /pets/1 应返回 200 和指定宠物');

  await assertAsync(async function() {
    var timestamp = Date.now().toString().slice(-8);
    var res = await axios.post(BASE_URL + '/pets', {
      name: 'test_pet_' + timestamp,
      photoUrls: ['https://example.com/photo.jpg'],
      status: 'available'
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.data.id, '新宠物应有 id');
    assert.strictEqual(res.data.name, 'test_pet_' + timestamp);
  }, suiteName, 'POST /pets 应返回 201 和新宠物');

  await assertAsync(async function() {
    var res = await axios.put(BASE_URL + '/pets/1', {
      name: 'updated_doggie',
      photoUrls: ['https://example.com/new-photo.jpg'],
      status: 'sold'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.name, 'updated_doggie');
  }, suiteName, 'PUT /pets/1 应返回 200 和更新后的宠物');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/orders');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data), '应返回订单数组');
  }, suiteName, 'GET /orders 应返回 200 和订单列表');

  await assertAsync(async function() {
    var res = await axios.post(BASE_URL + '/orders', {
      petId: 1,
      quantity: 2,
      status: 'placed'
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.data.id, '新订单应有 id');
  }, suiteName, 'POST /orders 应返回 201 和新订单');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/orders/1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.id, 1);
  }, suiteName, 'GET /orders/1 应返回 200 和指定订单');

  await assertAsync(async function() {
    var timestamp = Date.now().toString().slice(-8);
    var res = await axios.post(BASE_URL + '/users', {
      username: 'regtest_' + timestamp,
      email: 'regtest_' + timestamp + '@example.com',
      password: 'testPassword123'
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.data.id, '新用户应有 id');
  }, suiteName, 'POST /users 应返回 201 和新用户');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/users/john_doe');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.username, 'john_doe');
  }, suiteName, 'GET /users/john_doe 应返回 200 和用户信息');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/pets?status=available');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
    for (var i = 0; i < res.data.length; i++) {
      assert.strictEqual(res.data[i].status, 'available');
    }
  }, suiteName, 'GET /pets?status=available 应只返回可用宠物');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/pets?limit=1');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.length <= 1, '应最多返回 1 条');
  }, suiteName, 'GET /pets?limit=1 应限制返回数量');
}

async function runMockServerFailureSuite() {
  var suiteName = 'Mock Server 失败路径';
  console.log('\n📦 ' + suiteName);

  var httpOpts = { validateStatus: function() { return true; } };

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/pets/99999', httpOpts);
    assert.strictEqual(res.status, 404);
    assert.ok(res.data.message, '404 响应应有 message');
  }, suiteName, 'GET /pets/99999 应返回 404');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/orders/99999', httpOpts);
    assert.ok(res.status === 404 || res.status === 400, '不存在的订单应返回 404 或 400');
  }, suiteName, 'GET /orders/99999 应返回 4xx');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/users/nonexistent_user', httpOpts);
    assert.strictEqual(res.status, 404);
  }, suiteName, 'GET /users/nonexistent_user 应返回 404');

  await assertAsync(async function() {
    var res = await axios.post(BASE_URL + '/pets', {}, httpOpts);
    assert.strictEqual(res.status, 400);
    assert.ok(res.data.message, '400 响应应有 message');
  }, suiteName, 'POST /pets 缺少必填字段应返回 400');

  await assertAsync(async function() {
    var res = await axios.post(BASE_URL + '/pets', {
      name: 'test',
      photoUrls: ['https://example.com/photo.jpg'],
      status: 'invalid_status'
    }, httpOpts);
    assert.strictEqual(res.status, 400);
  }, suiteName, 'POST /pets 无效 status 应返回 400');

  await assertAsync(async function() {
    var res = await axios.post(BASE_URL + '/orders', {
      petId: 99999,
      quantity: 1
    }, httpOpts);
    assert.strictEqual(res.status, 400);
  }, suiteName, 'POST /orders 不存在的 petId 应返回 400');

  await assertAsync(async function() {
    var res = await axios.post(BASE_URL + '/orders', {
      petId: 1,
      quantity: 0
    }, httpOpts);
    assert.strictEqual(res.status, 400);
  }, suiteName, 'POST /orders 无效 quantity 应返回 400');

  await assertAsync(async function() {
    var res = await axios.post(BASE_URL + '/users', {
      username: 'ab',
      email: 'not-an-email',
      password: 'short'
    }, httpOpts);
    assert.strictEqual(res.status, 400);
  }, suiteName, 'POST /users 无效数据应返回 400');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/admin/stats', httpOpts);
    assert.ok(res.status === 401, '无认证访问 admin 应返回 401');
  }, suiteName, 'GET /admin/stats 无认证应返回 401');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/admin/stats', {
      headers: { 'Authorization': 'Bearer wrong-token' },
      validateStatus: function() { return true; }
    });
    assert.ok(res.status === 401, '错误 token 应返回 401');
  }, suiteName, 'GET /admin/stats 错误 token 应返回 401');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/pets?status=invalid', httpOpts);
    assert.strictEqual(res.status, 400);
  }, suiteName, 'GET /pets?status=invalid 应返回 400');

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/nonexistent-endpoint', httpOpts);
    assert.strictEqual(res.status, 404);
  }, suiteName, '访问不存在的端点应返回 404');
}

async function runMockServerAuthSuite() {
  var suiteName = 'Mock Server 认证路径';
  console.log('\n📦 ' + suiteName);

  await assertAsync(async function() {
    var res = await axios.get(BASE_URL + '/admin/stats', {
      headers: { 'Authorization': 'Bearer admin-token-12345' }
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.totalPets !== undefined, '应返回统计数据');
  }, suiteName, 'GET /admin/stats 正确 bearer token 应返回 200');

  await assertAsync(async function() {
    var res = await axios.head(BASE_URL + '/admin/stats', {
      headers: { 'Authorization': 'Bearer admin-token-12345' }
    });
    assert.strictEqual(res.status, 200);
  }, suiteName, 'HEAD /admin/stats 正确 bearer token 应返回 200');

  await assertAsync(async function() {
    var verifyResult = await auth.verifyAuth(BASE_URL, {
      authType: 'bearer',
      authToken: 'admin-token-12345'
    });
    assert.strictEqual(verifyResult.authorized, true, '正确 token 应验证通过');
  }, suiteName, 'verifyAuth 正确 token 应返回 authorized=true');

  await assertAsync(async function() {
    var verifyResult = await auth.verifyAuth(BASE_URL, {
      authType: 'bearer',
      authToken: 'wrong-token'
    });
    assert.strictEqual(verifyResult.authorized, false, '错误 token 应验证失败');
  }, suiteName, 'verifyAuth 错误 token 应返回 authorized=false');
}

async function runIntegrationSuite() {
  var suiteName = '集成测试 - 完整 run 流程';
  console.log('\n📦 ' + suiteName);

  var parsedAPI = parser.parseOpenAPI(OPENAPI_FILE);
  var testSuite = testGenerator.generateAllTests(parsedAPI);

  await assertAsync(async function() {
    var results = await testRunner.runAllTests(testSuite, BASE_URL, {
      timeout: 10000,
      plugins: []
    });
    assert.ok(results.totalTests > 0, '应有测试结果');
    assert.ok(results.passed + results.failed > 0, '应有执行结果');
    assert.ok(results.testResults.length > 0, '应有测试详情');
    assert.ok(results.duration > 0, '应有执行时长');
    assert.ok(results.endpointCoverage, '应有端点覆盖率');
  }, suiteName, '完整 run 流程应返回完整测试结果');

  await assertAsync(async function() {
    var results = await testRunner.runAllTests(testSuite, BASE_URL, {
      timeout: 10000,
      authType: 'bearer',
      authToken: 'admin-token-12345',
      plugins: []
    });
    assert.ok(results.totalTests > 0);
  }, suiteName, '带认证的 run 流程应正常完成');

  await assertAsync(async function() {
    var results = await testRunner.runAllTests(testSuite, BASE_URL, {
      timeout: 10000,
      plugins: [PLUGIN_DIR]
    });
    assert.ok(results.totalTests > 0);
  }, suiteName, '带插件的 run 流程应正常完成');

  await assertAsync(async function() {
    var ts = testGenerator.generateAllTests(parsedAPI);
    var pattern = new RegExp('pet', 'i');
    ts.testCases = ts.testCases.filter(function(t) {
      return pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method);
    });
    ts.totalTests = ts.testCases.length;

    var results = await testRunner.runAllTests(ts, BASE_URL, {
      timeout: 10000,
      plugins: []
    });
    assert.ok(results.totalTests > 0, '过滤后应有测试');
    assert.ok(results.totalTests < testSuite.totalTests, '过滤后测试数应少于总数');
  }, suiteName, '带 filter 的 run 流程应只运行匹配测试');
}

function generateTestReport() {
  results.endTime = Date.now();
  results.duration = results.endTime - results.startTime;

  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  var timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  var mdLines = [];
  mdLines.push('# API 合约回归测试报告');
  mdLines.push('');
  mdLines.push('**生成时间:** ' + new Date().toISOString());
  mdLines.push('**总耗时:** ' + results.duration + 'ms');
  mdLines.push('');
  mdLines.push('## 摘要');
  mdLines.push('');
  mdLines.push('| 指标 | 值 |');
  mdLines.push('|------|-----|');
  mdLines.push('| 总测试数 | ' + results.total + ' |');
  mdLines.push('| ✅ 通过 | ' + results.passed + ' |');
  mdLines.push('| ❌ 失败 | ' + results.failed + ' |');
  mdLines.push('| 通过率 | ' + (results.total > 0 ? Math.round(results.passed / results.total * 100) : 0) + '% |');
  mdLines.push('');

  for (var s = 0; s < results.suites.length; s++) {
    var suite = results.suites[s];
    mdLines.push('## ' + suite.name);
    mdLines.push('');
    mdLines.push('| 状态 | 测试名称 |');
    mdLines.push('|------|----------|');
    for (var t = 0; t < suite.tests.length; t++) {
      var test = suite.tests[t];
      var icon = test.passed ? '✅' : '❌';
      var name = test.passed ? test.name : test.name + (test.error ? ' (' + test.error + ')' : '');
      mdLines.push('| ' + icon + ' | ' + name + ' |');
    }
    mdLines.push('');
  }

  var mdPath = path.join(REPORT_DIR, 'regression-report-' + timestamp + '.md');
  fs.writeFileSync(mdPath, mdLines.join('\n'));

  var htmlContent = generateHTMLReport(results);
  var htmlPath = path.join(REPORT_DIR, 'regression-report-' + timestamp + '.html');
  fs.writeFileSync(htmlPath, htmlContent);

  console.log('\n📊 测试报告已生成:');
  console.log('   • Markdown: ' + mdPath);
  console.log('   • HTML: ' + htmlPath);

  return { mdPath: mdPath, htmlPath: htmlPath };
}

function generateHTMLReport(results) {
  var passRate = results.total > 0 ? Math.round(results.passed / results.total * 100) : 0;
  var rateClass = passRate >= 80 ? 'good' : passRate >= 50 ? 'medium' : 'bad';

  var suiteRows = '';
  for (var s = 0; s < results.suites.length; s++) {
    var suite = results.suites[s];
    var suitePassed = suite.tests.filter(function(t) { return t.passed; }).length;
    var suiteFailed = suite.tests.filter(function(t) { return !t.passed; }).length;
    var suiteStatus = suiteFailed === 0 ? 'pass' : 'fail';
    var suiteIcon = suiteFailed === 0 ? '✅' : '❌';

    var testItems = '';
    for (var t = 0; t < suite.tests.length; t++) {
      var test = suite.tests[t];
      var testIcon = test.passed ? '✅' : '❌';
      var testClass = test.passed ? 'pass' : 'fail';
      var errorDetail = test.error ? '<div class="error-item"><span class="error-type">ERROR</span><span class="error-message">' + escapeHtml(test.error) + '</span></div>' : '';
      testItems += '<div class="test-item ' + testClass + '" data-status="' + testClass + '">' +
        '<div class="test-header">' +
        '<span class="test-icon">' + testIcon + '</span>' +
        '<span class="test-name">' + escapeHtml(test.name) + '</span>' +
        '</div>' +
        errorDetail +
        '</div>';
    }

    suiteRows += '<div class="endpoint-panel ' + suiteStatus + '" data-status="' + suiteStatus + '">' +
      '<div class="endpoint-header" onclick="toggleEndpoint(this)">' +
      '<span class="endpoint-status">' + suiteIcon + '</span>' +
      '<span class="endpoint-path">' + escapeHtml(suite.name) + '</span>' +
      '<span class="endpoint-stats">' + suitePassed + '/' + suite.tests.length + ' passed</span>' +
      '<span class="toggle-icon">▼</span>' +
      '</div>' +
      '<div class="endpoint-content">' + testItems + '</div>' +
      '</div>';
  }

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>API 合约回归测试报告</title>\n' +
    '<style>\n' +
    '  * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f7fa; color: #333; padding: 20px; }\n' +
    '  .container { max-width: 1200px; margin: 0 auto; }\n' +
    '  h1 { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 12px; margin-bottom: 20px; font-size: 24px; }\n' +
    '  .info-bar { background: white; padding: 15px 20px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 30px; flex-wrap: wrap; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }\n' +
    '  .info-item { display: flex; flex-direction: column; gap: 4px; }\n' +
    '  .info-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }\n' +
    '  .info-value { font-size: 14px; font-weight: 600; }\n' +
    '  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }\n' +
    '  .stat-item { background: white; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }\n' +
    '  .stat-item.total { border-top: 3px solid #1565c0; }\n' +
    '  .stat-item.pass { border-top: 3px solid #2e7d32; }\n' +
    '  .stat-item.fail { border-top: 3px solid #c62828; }\n' +
    '  .stat-item.rate { border-top: 3px solid #764ba2; }\n' +
    '  .stat-number { font-size: 32px; font-weight: bold; }\n' +
    '  .stat-item.total .stat-number { color: #1565c0; }\n' +
    '  .stat-item.pass .stat-number { color: #2e7d32; }\n' +
    '  .stat-item.fail .stat-number { color: #c62828; }\n' +
    '  .stat-item.rate .stat-number { color: #764ba2; }\n' +
    '  .stat-label { font-size: 12px; color: #666; text-transform: uppercase; margin-top: 4px; }\n' +
    '  .endpoint-panel { background: white; border-radius: 8px; margin-bottom: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); overflow: hidden; }\n' +
    '  .endpoint-header { padding: 15px 20px; cursor: pointer; display: flex; align-items: center; gap: 12px; user-select: none; }\n' +
    '  .endpoint-header:hover { background: #f9f9f9; }\n' +
    '  .endpoint-status { font-size: 16px; }\n' +
    '  .endpoint-path { flex: 1; font-size: 14px; font-weight: 600; }\n' +
    '  .endpoint-stats { font-size: 12px; color: #666; margin-left: auto; margin-right: 10px; }\n' +
    '  .toggle-icon { font-size: 10px; color: #999; transition: transform 0.2s; }\n' +
    '  .endpoint-header.open .toggle-icon { transform: rotate(180deg); }\n' +
    '  .endpoint-content { display: none; border-top: 1px solid #eee; }\n' +
    '  .endpoint-header.open + .endpoint-content { display: block; }\n' +
    '  .test-item { border-bottom: 1px solid #f0f0f0; padding: 10px 20px 10px 40px; }\n' +
    '  .test-item:last-child { border-bottom: none; }\n' +
    '  .test-header { display: flex; align-items: center; gap: 10px; }\n' +
    '  .test-icon { font-size: 14px; }\n' +
    '  .test-name { flex: 1; font-size: 13px; }\n' +
    '  .error-item { background: #ffebee; padding: 8px 12px; border-radius: 4px; margin: 6px 0 6px 24px; font-size: 12px; }\n' +
    '  .error-type { display: inline-block; background: #c62828; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-right: 8px; text-transform: uppercase; }\n' +
    '  .error-message { color: #b71c1c; }\n' +
    '</style>\n</head>\n<body>\n' +
    '<div class="container">\n' +
    '<h1>📋 API 合约回归测试报告</h1>\n' +
    '<div class="info-bar">\n' +
    '  <div class="info-item"><span class="info-label">生成时间</span><span class="info-value">' + new Date().toLocaleString() + '</span></div>\n' +
    '  <div class="info-item"><span class="info-label">耗时</span><span class="info-value">' + results.duration + 'ms</span></div>\n' +
    '</div>\n' +
    '<div class="stat-grid">\n' +
    '  <div class="stat-item total"><div class="stat-number">' + results.total + '</div><div class="stat-label">总测试数</div></div>\n' +
    '  <div class="stat-item pass"><div class="stat-number">' + results.passed + '</div><div class="stat-label">通过</div></div>\n' +
    '  <div class="stat-item fail"><div class="stat-number">' + results.failed + '</div><div class="stat-label">失败</div></div>\n' +
    '  <div class="stat-item rate"><div class="stat-number">' + passRate + '%</div><div class="stat-label">通过率</div></div>\n' +
    '</div>\n' +
    suiteRows + '\n' +
    '</div>\n' +
    '<script>\n' +
    'function toggleEndpoint(header) { header.classList.toggle("open"); }\n' +
    '</script>\n' +
    '</body>\n</html>';
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'string') text = String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function main() {
  console.log('\n🚀 API 合约回归测试');
  console.log('═'.repeat(60));

  console.log('\n🔧 启动 Mock Server...');
  try {
    await startMockServer();
    await waitForServer(BASE_URL + '/pets');
    console.log('✅ Mock Server 已启动');
  } catch (e) {
    console.error('❌ Mock Server 启动失败:', e.message);
    process.exit(1);
  }

  try {
    var testSuite = runTestGeneratorSuite();
    runFilterSuite(testSuite);
    runAuthSuite();
    runPluginLoaderSuite();
    await runPluginHooksSuite();
    await runIsolatedSuite();
    runReporterSuite();
    await runMockServerSuccessSuite();
    await runMockServerFailureSuite();
    await runMockServerAuthSuite();
    await runIntegrationSuite();
  } finally {
    console.log('\n🔧 停止 Mock Server...');
    stopMockServer();
    console.log('✅ Mock Server 已停止');
  }

  var reportPaths = generateTestReport();

  console.log('\n' + '═'.repeat(60));
  console.log('📊 回归测试结果');
  console.log('═'.repeat(60));
  console.log('  总测试数: ' + results.total);
  console.log('  ✅ 通过: ' + results.passed);
  console.log('  ❌ 失败: ' + results.failed);
  var passRate = results.total > 0 ? Math.round(results.passed / results.total * 100) : 0;
  console.log('  📈 通过率: ' + passRate + '%');
  console.log('');

  if (results.failed > 0) {
    console.log('❌ 失败的测试:');
    for (var s = 0; s < results.suites.length; s++) {
      var suite = results.suites[s];
      for (var t = 0; t < suite.tests.length; t++) {
        var test = suite.tests[t];
        if (!test.passed) {
          console.log('   • [' + suite.name + '] ' + test.name);
          if (test.error) console.log('     ' + test.error);
        }
      }
    }
  }

  console.log('\n📄 报告路径:');
  console.log('   Markdown: ' + reportPaths.mdPath);
  console.log('   HTML: ' + reportPaths.htmlPath);

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(function(e) {
  console.error('Fatal error:', e);
  stopMockServer();
  process.exit(1);
});
