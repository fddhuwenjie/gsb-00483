const fs = require('fs');
const path = require('path');

const logFilePath = path.resolve(process.cwd(), 'request-log.jsonl');

let logStream = null;

function ensureStream() {
  if (!logStream) {
    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  }
  return logStream;
}

function beforeAll(testSuite) {
  ensureStream();
  const entry = {
    timestamp: new Date().toISOString(),
    event: 'test_run_start',
    totalTests: testSuite.totalTests,
    apiInfo: testSuite.apiInfo
  };
  logStream.write(JSON.stringify(entry) + '\n');
}

function beforeEach(testCase) {
  ensureStream();
  const entry = {
    timestamp: new Date().toISOString(),
    event: 'request',
    testId: testCase.id,
    testDescription: testCase.description,
    method: testCase.request.method,
    path: testCase.request.path,
    queryParams: testCase.request.queryParams,
    headers: testCase.request.headers,
    body: testCase.request.body
  };
  logStream.write(JSON.stringify(entry) + '\n');
  
  return testCase;
}

function afterEach(testCase, result) {
  ensureStream();
  const entry = {
    timestamp: new Date().toISOString(),
    event: 'response',
    testId: testCase.id,
    testDescription: testCase.description,
    status: result.status,
    httpStatus: result.actualStatus,
    duration: result.duration,
    responseBody: result.response?.data,
    errors: result.errors
  };
  logStream.write(JSON.stringify(entry) + '\n');
}

function afterAll(results) {
  ensureStream();
  const entry = {
    timestamp: new Date().toISOString(),
    event: 'test_run_end',
    passed: results.passed,
    failed: results.failed,
    skipped: results.skipped,
    duration: results.duration
  };
  logStream.write(JSON.stringify(entry) + '\n');
  
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

module.exports = {
  name: 'log-plugin',
  beforeAll,
  beforeEach,
  afterEach,
  afterAll
};
