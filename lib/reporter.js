const fs = require('fs');
const path = require('path');
const { create } = require('xmlbuilder2');

function generateJUnitXML(results, options = {}) {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('testsuites', {
      name: options.suiteName || 'API Contract Tests',
      tests: results.totalTests,
      failures: results.failed,
      errors: 0,
      skipped: results.skipped,
      time: (results.duration / 1000).toFixed(3)
    });

  const testSuites = {};
  
  for (const testResult of results.testResults) {
    const tag = testResult.endpoint.tags && testResult.endpoint.tags.length > 0 
      ? testResult.endpoint.tags[0] 
      : 'default';
    
    if (!testSuites[tag]) {
      testSuites[tag] = {
        tests: 0,
        failures: 0,
        skipped: 0,
        time: 0,
        cases: []
      };
    }
    
    testSuites[tag].tests++;
    if (testResult.status === 'fail') {
      testSuites[tag].failures++;
    }
    if (testResult.status === 'skipped') {
      testSuites[tag].skipped++;
    }
    testSuites[tag].time += testResult.duration;
    testSuites[tag].cases.push(testResult);
  }

  for (const [suiteName, suiteData] of Object.entries(testSuites)) {
    const testSuite = root.ele('testsuite', {
      name: suiteName,
      tests: suiteData.tests,
      failures: suiteData.failures,
      errors: 0,
      skipped: suiteData.skipped,
      time: (suiteData.time / 1000).toFixed(3),
      timestamp: new Date(results.startTime).toISOString()
    });

    for (const testCase of suiteData.cases) {
      const tc = testSuite.ele('testcase', {
        classname: `${testCase.endpoint.method} ${testCase.endpoint.path}`,
        name: testCase.description,
        time: (testCase.duration / 1000).toFixed(3)
      });

      if (testCase.status === 'fail') {
        for (const error of testCase.errors) {
          tc.ele('failure', {
            type: error.type || 'assertion_failed',
            message: error.message || 'Test failed'
          }).txt(formatErrorMessage(error));
        }
      }

      if (testCase.status === 'skipped') {
        tc.ele('skipped').txt('Dry run - test not executed');
      }

      if (testCase.request) {
        const systemOut = tc.ele('system-out');
        systemOut.txt(`Request: ${JSON.stringify(testCase.request, null, 2)}`);
      }

      if (testCase.response) {
        const systemErr = tc.ele('system-err');
        systemErr.txt(`Response Status: ${testCase.response.status}\nResponse Body: ${JSON.stringify(testCase.response.data, null, 2)}`);
      }
    }
  }

  return root.end({ prettyPrint: true });
}

function formatErrorMessage(error) {
  let msg = error.message || 'Unknown error';
  if (error.path) {
    msg += `\nPath: ${error.path}`;
  }
  if (error.expected !== undefined) {
    msg += `\nExpected: ${JSON.stringify(error.expected)}`;
  }
  if (error.actual !== undefined) {
    msg += `\nActual: ${JSON.stringify(error.actual)}`;
  }
  if (error.details && typeof error.details === 'string') {
    msg += `\nDetails: ${error.details}`;
  }
  return msg;
}

function generateMarkdownReport(results, options = {}) {
  const lines = [];
  
  lines.push('# API Contract Test Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**API:** ${results.apiInfo?.title || 'Unknown'} (${results.apiInfo?.version || 'N/A'})`);
  lines.push(`**Base URL:** ${results.baseUrl}`);
  lines.push(`**Duration:** ${formatDuration(results.duration)}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total Endpoints | ${results.totalEndpoints} |`);
  lines.push(`| Tested Endpoints | ${results.endpointCoverage?.tested || 0} (${calculatePercentage(results.endpointCoverage?.tested || 0, results.totalEndpoints)}%) |`);
  lines.push(`| Total Tests | ${results.totalTests} |`);
  lines.push(`| ✅ Passed | ${results.passed} |`);
  lines.push(`| ❌ Failed | ${results.failed} |`);
  lines.push(`| ⏭️ Skipped | ${results.skipped} |`);
  lines.push(`| **Pass Rate** | **${calculatePercentage(results.passed, results.totalTests)}%** |`);
  lines.push('');

  lines.push('## Endpoint Coverage');
  lines.push('');
  lines.push(`| Status | Method | Path | Tests | Passed | Failed |`);
  lines.push('|--------|--------|------|-------|--------|--------|');
  
  for (const ep of results.endpointCoverage?.details || []) {
    const statusIcon = ep.status === 'pass' ? '✅' : '❌';
    lines.push(`| ${statusIcon} | ${ep.method} | \`${ep.path}\` | ${ep.testsTotal} | ${ep.testsPassed} | ${ep.testsFailed} |`);
  }
  lines.push('');

  if (results.endpointCoverage?.notTested?.length > 0) {
    lines.push('### Endpoints Not Tested');
    lines.push('');
    for (const ep of results.endpointCoverage.notTested) {
      lines.push(`- ${ep.method} \`${ep.path}\` (${ep.operationId || 'N/A'})`);
    }
    lines.push('');
  }

  lines.push('## Test Results');
  lines.push('');

  const passedTests = results.testResults.filter(t => t.status === 'pass');
  const failedTests = results.testResults.filter(t => t.status === 'fail');
  const skippedTests = results.testResults.filter(t => t.status === 'skipped');

  if (failedTests.length > 0) {
    lines.push('### ❌ Failed Tests');
    lines.push('');
    for (const test of failedTests) {
      lines.push(`#### ${test.description}`);
      lines.push(`- **Endpoint:** ${test.endpoint.method} \`${test.endpoint.path}\``);
      lines.push(`- **Type:** ${test.type}`);
      lines.push(`- **Duration:** ${formatDuration(test.duration)}`);
      lines.push(`- **Expected Status:** ${test.expectedStatus}`);
      lines.push(`- **Actual Status:** ${test.actualStatus}`);
      lines.push('');
      lines.push('**Errors:**');
      for (const error of test.errors) {
        lines.push(`1. **${error.type}:** ${error.message}`);
        if (error.path) lines.push(`   - Path: \`${error.path}\``);
        if (error.expected !== undefined) lines.push(`   - Expected: \`${JSON.stringify(error.expected)}\``);
        if (error.actual !== undefined) lines.push(`   - Actual: \`${JSON.stringify(error.actual)}\``);
      }
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Show Request/Response</summary>');
      lines.push('');
      lines.push('**Request:**');
      lines.push('```json');
      lines.push(JSON.stringify(test.request, null, 2));
      lines.push('```');
      lines.push('');
      lines.push('**Response:**');
      lines.push('```json');
      lines.push(JSON.stringify(test.response?.data || null, null, 2));
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  if (passedTests.length > 0) {
    lines.push('### ✅ Passed Tests');
    lines.push('');
    for (const test of passedTests) {
      const statusMatch = test.expectedStatus === test.actualStatus ? '✅' : '⚠️';
      lines.push(`- ${statusMatch} **${test.description}** (${formatDuration(test.duration)})`);
    }
    lines.push('');
  }

  if (skippedTests.length > 0) {
    lines.push('### ⏭️ Skipped Tests');
    lines.push('');
    for (const test of skippedTests) {
      lines.push(`- **${test.description}**`);
    }
    lines.push('');
  }

  lines.push('## Schema Validation Details');
  lines.push('');
  lines.push('### Failed Schema Validations');
  lines.push('');

  const schemaFailures = results.testResults.filter(
    t => t.schemaValidation && !t.schemaValidation.passed && t.schemaValidation.errors.length > 0
  );

  if (schemaFailures.length === 0) {
    lines.push('*No schema validation failures*');
  } else {
    for (const test of schemaFailures) {
      lines.push(`#### ${test.description}`);
      for (const error of test.schemaValidation.errors) {
        lines.push(`- **Path:** \`${error.instancePath || '/'}\``);
        lines.push(`  **Issue:** ${error.message}`);
        lines.push(`  **Keyword:** \`${error.keyword}\``);
        if (error.params) {
          lines.push(`  **Params:** \`${JSON.stringify(error.params)}\``);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generateHTMLReport(results, options = {}) {
  const pieChart = generatePieChartSVG(results);
  
  const passedTests = results.testResults.filter(t => t.status === 'pass');
  const failedTests = results.testResults.filter(t => t.status === 'fail');
  const skippedTests = results.testResults.filter(t => t.status === 'skipped');

  const endpointGroups = {};
  for (const test of results.testResults) {
    const key = `${test.endpoint.method} ${test.endpoint.path}`;
    if (!endpointGroups[key]) {
      endpointGroups[key] = {
        endpoint: test.endpoint,
        tests: []
      };
    }
    endpointGroups[key].tests.push(test);
  }

  let endpointPanels = '';
  for (const [key, group] of Object.entries(endpointGroups)) {
    const ep = group.endpoint;
    const passed = group.tests.filter(t => t.status === 'pass').length;
    const failed = group.tests.filter(t => t.status === 'fail').length;
    const statusClass = failed > 0 ? 'fail' : 'pass';
    const statusIcon = failed > 0 ? '❌' : '✅';
    
    let testItems = '';
    for (const test of group.tests) {
      const testStatusClass = test.status;
      const testStatusIcon = test.status === 'pass' ? '✅' : test.status === 'fail' ? '❌' : '⏭️';
      
      let detailsHtml = '';
      if (test.status === 'fail') {
        let errorsHtml = '';
        for (const err of test.errors) {
          errorsHtml += `<div class="error-item">
            <span class="error-type">${err.type || 'error'}</span>
            <span class="error-message">${escapeHtml(err.message)}</span>
          </div>`;
        }
        
        const requestBody = typeof test.request?.body === 'object' 
          ? JSON.stringify(test.request.body, null, 2) 
          : (test.request?.body || '');
        const responseBody = typeof test.response?.data === 'object' 
          ? JSON.stringify(test.response.data, null, 2) 
          : (test.response?.data || '');
        
        let requestHeaders = '';
        if (test.request?.headers) {
          for (const [hKey, hVal] of Object.entries(test.request.headers)) {
            requestHeaders += `<div><span class="header-key">${escapeHtml(hKey)}:</span> ${escapeHtml(String(hVal))}</div>`;
          }
        }
        
        let responseHeaders = '';
        if (test.response?.headers) {
          for (const [hKey, hVal] of Object.entries(test.response.headers)) {
            responseHeaders += `<div><span class="header-key">${escapeHtml(hKey)}:</span> ${escapeHtml(String(hVal))}</div>`;
          }
        }
        
        detailsHtml = `
          <div class="test-details">
            <div class="details-section">
              <h4>Request</h4>
              <div class="detail-row"><span class="detail-label">URL:</span> ${escapeHtml(test.request?.method || '')} ${escapeHtml(test.request?.path || '')}</div>
              <div class="detail-row"><span class="detail-label">Headers:</span></div>
              <div class="headers-block">${requestHeaders || '<em>None</em>'}</div>
              <div class="detail-row"><span class="detail-label">Body:</span></div>
              <pre class="body-block">${escapeHtml(requestBody) || '<em>Empty</em>'}</pre>
            </div>
            <div class="details-section">
              <h4>Response</h4>
              <div class="detail-row"><span class="detail-label">Status:</span> ${test.actualStatus || 'N/A'}</div>
              <div class="detail-row"><span class="detail-label">Headers:</span></div>
              <div class="headers-block">${responseHeaders || '<em>None</em>'}</div>
              <div class="detail-row"><span class="detail-label">Body:</span></div>
              <pre class="body-block">${escapeHtml(responseBody) || '<em>Empty</em>'}</pre>
            </div>
            <div class="details-section">
              <h4>Errors</h4>
              ${errorsHtml}
            </div>
          </div>
        `;
      }
      
      testItems += `
        <div class="test-item ${testStatusClass}" data-status="${test.status}">
          <div class="test-header" onclick="toggleTestDetails(this)">
            <span class="test-icon">${testStatusIcon}</span>
            <span class="test-name">${escapeHtml(test.description)}</span>
            <span class="test-duration">${formatDuration(test.duration)}</span>
            <span class="toggle-icon">▼</span>
          </div>
          ${detailsHtml}
        </div>
      `;
    }
    
    endpointPanels += `
      <div class="endpoint-panel ${statusClass}" data-status="${statusClass}">
        <div class="endpoint-header" onclick="toggleEndpoint(this)">
          <span class="endpoint-status">${statusIcon}</span>
          <span class="endpoint-method method-${ep.method.toLowerCase()}">${ep.method}</span>
          <span class="endpoint-path">${escapeHtml(ep.path)}</span>
          <span class="endpoint-stats">${passed}/${group.tests.length} passed</span>
          <span class="toggle-icon">▼</span>
        </div>
        <div class="endpoint-content">
          ${testItems}
        </div>
      </div>
    `;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Contract Test Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      color: #333;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 12px;
      margin-bottom: 20px;
      font-size: 24px;
    }
    .info-bar {
      background: white;
      padding: 15px 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      display: flex;
      gap: 30px;
      flex-wrap: wrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    .info-item { display: flex; flex-direction: column; gap: 4px; }
    .info-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
    .info-value { font-size: 14px; font-weight: 600; }
    
    .dashboard {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: 20px;
      margin-bottom: 30px;
    }
    @media (max-width: 768px) {
      .dashboard { grid-template-columns: 1fr; }
    }
    
    .chart-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .chart-card h2 { font-size: 16px; margin-bottom: 15px; color: #555; }
    
    .stats-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    .stats-card h2 { font-size: 16px; margin-bottom: 15px; color: #555; }
    
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 15px;
    }
    .stat-item {
      padding: 15px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-item.pass { background: #e8f5e9; }
    .stat-item.fail { background: #ffebee; }
    .stat-item.skipped { background: #f5f5f5; }
    .stat-item.total { background: #e3f2fd; }
    .stat-number { font-size: 28px; font-weight: bold; margin-bottom: 4px; }
    .stat-item.pass .stat-number { color: #2e7d32; }
    .stat-item.fail .stat-number { color: #c62828; }
    .stat-item.skipped .stat-number { color: #616161; }
    .stat-item.total .stat-number { color: #1565c0; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; }
    
    .filter-bar {
      background: white;
      padding: 15px 20px;
      border-radius: 8px;
      margin-bottom: 15px;
      display: flex;
      gap: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    .filter-btn {
      padding: 8px 16px;
      border: 1px solid #ddd;
      background: white;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      transition: all 0.2s;
    }
    .filter-btn:hover { background: #f5f5f5; }
    .filter-btn.active {
      background: #667eea;
      color: white;
      border-color: #667eea;
    }
    
    .endpoint-panel {
      background: white;
      border-radius: 8px;
      margin-bottom: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
      overflow: hidden;
    }
    .endpoint-header {
      padding: 15px 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 12px;
      user-select: none;
      transition: background 0.2s;
    }
    .endpoint-header:hover { background: #f9f9f9; }
    .endpoint-status { font-size: 16px; }
    .endpoint-method {
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
      color: white;
      min-width: 60px;
      text-align: center;
    }
    .method-get { background: #61affe; }
    .method-post { background: #49cc90; }
    .method-put { background: #fca130; }
    .method-delete { background: #f93e3e; }
    .method-patch { background: #50e3c2; }
    .endpoint-path {
      flex: 1;
      font-family: monospace;
      font-size: 14px;
    }
    .endpoint-stats {
      font-size: 12px;
      color: #666;
      margin-left: auto;
      margin-right: 10px;
    }
    .toggle-icon {
      font-size: 10px;
      color: #999;
      transition: transform 0.2s;
    }
    .endpoint-header.open .toggle-icon { transform: rotate(180deg); }
    
    .endpoint-content {
      display: none;
      border-top: 1px solid #eee;
    }
    .endpoint-header.open + .endpoint-content { display: block; }
    
    .test-item {
      border-bottom: 1px solid #f0f0f0;
    }
    .test-item:last-child { border-bottom: none; }
    .test-header {
      padding: 12px 20px 12px 50px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      user-select: none;
    }
    .test-header:hover { background: #fafafa; }
    .test-icon { font-size: 14px; }
    .test-name { flex: 1; font-size: 13px; }
    .test-duration { font-size: 11px; color: #999; margin-right: 5px; }
    
    .test-details {
      display: none;
      padding: 15px 20px 15px 50px;
      background: #fafafa;
      border-top: 1px solid #f0f0f0;
    }
    .test-header.open + .test-details { display: block; }
    
    .details-section {
      margin-bottom: 15px;
    }
    .details-section h4 {
      font-size: 13px;
      color: #555;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid #e0e0e0;
    }
    .detail-row {
      font-size: 12px;
      margin-bottom: 4px;
    }
    .detail-label {
      font-weight: 600;
      color: #666;
    }
    .headers-block {
      background: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 11px;
      margin-bottom: 8px;
      border: 1px solid #e0e0e0;
    }
    .header-key {
      color: #764ba2;
      font-weight: 600;
    }
    .body-block {
      background: white;
      padding: 10px 12px;
      border-radius: 4px;
      font-size: 11px;
      max-height: 200px;
      overflow: auto;
      border: 1px solid #e0e0e0;
      white-space: pre-wrap;
      word-break: break-all;
    }
    
    .error-item {
      background: #ffebee;
      padding: 8px 12px;
      border-radius: 4px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .error-type {
      display: inline-block;
      background: #c62828;
      color: white;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      margin-right: 8px;
      text-transform: uppercase;
    }
    .error-message { color: #b71c1c; }
    
    .legend {
      display: flex;
      gap: 20px;
      margin-top: 15px;
      font-size: 12px;
      justify-content: center;
    }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 2px;
    }
    .legend-color.pass { background: #4caf50; }
    .legend-color.fail { background: #f44336; }
    .legend-color.skipped { background: #9e9e9e; }
    
    .pass-rate {
      font-size: 32px;
      font-weight: bold;
      text-align: center;
      margin-top: 10px;
    }
    .pass-rate.good { color: #2e7d32; }
    .pass-rate.medium { color: #f57c00; }
    .pass-rate.bad { color: #c62828; }
    .pass-rate-label {
      text-align: center;
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📋 API Contract Test Report</h1>
    
    <div class="info-bar">
      <div class="info-item">
        <span class="info-label">API</span>
        <span class="info-value">${escapeHtml(results.apiInfo?.title || 'Unknown')} v${escapeHtml(results.apiInfo?.version || 'N/A')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Base URL</span>
        <span class="info-value">${escapeHtml(results.baseUrl || 'N/A')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Duration</span>
        <span class="info-value">${formatDuration(results.duration)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Generated</span>
        <span class="info-value">${new Date().toLocaleString()}</span>
      </div>
    </div>
    
    <div class="dashboard">
      <div class="chart-card">
        <h2>Test Results</h2>
        ${pieChart}
        <div class="legend">
          <div class="legend-item"><span class="legend-color pass"></span> Passed (${results.passed})</div>
          <div class="legend-item"><span class="legend-color fail"></span> Failed (${results.failed})</div>
          <div class="legend-item"><span class="legend-color skipped"></span> Skipped (${results.skipped})</div>
        </div>
        <div class="pass-rate ${getPassRateClass(results)}">${calculatePercentage(results.passed, results.totalTests)}%</div>
        <div class="pass-rate-label">Pass Rate</div>
      </div>
      
      <div class="stats-card">
        <h2>Statistics</h2>
        <div class="stat-grid">
          <div class="stat-item total">
            <div class="stat-number">${results.totalTests}</div>
            <div class="stat-label">Total Tests</div>
          </div>
          <div class="stat-item total">
            <div class="stat-number">${results.endpointCoverage?.tested || 0}/${results.totalEndpoints}</div>
            <div class="stat-label">Endpoints Tested</div>
          </div>
          <div class="stat-item pass">
            <div class="stat-number">${results.passed}</div>
            <div class="stat-label">Passed</div>
          </div>
          <div class="stat-item fail">
            <div class="stat-number">${results.failed}</div>
            <div class="stat-label">Failed</div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="filter-bar">
      <span style="font-weight: 600; font-size: 14px; margin-right: 10px; align-self: center;">Filter:</span>
      <button class="filter-btn active" onclick="filterTests('all', this)">All (${results.totalTests})</button>
      <button class="filter-btn" onclick="filterTests('pass', this)">Passed (${results.passed})</button>
      <button class="filter-btn" onclick="filterTests('fail', this)">Failed (${results.failed})</button>
    </div>
    
    <div id="endpoints-container">
      ${endpointPanels}
    </div>
  </div>
  
  <script>
    function toggleEndpoint(header) {
      header.classList.toggle('open');
    }
    
    function toggleTestDetails(header) {
      header.classList.toggle('open');
    }
    
    function filterTests(status, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const panels = document.querySelectorAll('.endpoint-panel');
      panels.forEach(panel => {
        if (status === 'all') {
          panel.style.display = 'block';
        } else {
          const panelStatus = panel.getAttribute('data-status');
          if (panelStatus === 'pass' && status === 'pass') {
            panel.style.display = 'block';
          } else if (status === 'fail') {
            const hasFail = panel.querySelector('.test-item.fail');
            panel.style.display = hasFail ? 'block' : 'none';
          } else {
            panel.style.display = 'none';
          }
        }
      });
      
      const testItems = document.querySelectorAll('.test-item');
      testItems.forEach(item => {
        if (status === 'all') {
          item.style.display = 'block';
        } else {
          const itemStatus = item.getAttribute('data-status');
          item.style.display = itemStatus === status ? 'block' : 'none';
        }
      });
    }
  </script>
</body>
</html>`;

  return html;
}

function getPassRateClass(results) {
  const rate = calculatePercentage(results.passed, results.totalTests);
  if (rate >= 80) return 'good';
  if (rate >= 50) return 'medium';
  return 'bad';
}

function generatePieChartSVG(results) {
  const total = results.totalTests;
  if (total === 0) {
    return '<svg width="150" height="150" viewBox="0 0 150 150"><circle cx="75" cy="75" r="60" fill="#e0e0e0"/></svg>';
  }

  const passCount = results.passed;
  const failCount = results.failed;
  const skipCount = results.skipped;

  const passPercent = passCount / total;
  const failPercent = failCount / total;
  const skipPercent = skipCount / total;

  const radius = 60;
  const cx = 75;
  const cy = 75;

  const passEndAngle = passPercent * Math.PI * 2 - Math.PI / 2;
  const failEndAngle = (passPercent + failPercent) * Math.PI * 2 - Math.PI / 2;
  const skipEndAngle = Math.PI * 2 - Math.PI / 2;

  const passLargeArc = passPercent > 0.5 ? 1 : 0;
  const failLargeArc = failPercent > 0.5 ? 1 : 0;
  const skipLargeArc = skipPercent > 0.5 ? 1 : 0;

  const passX = cx + radius * Math.cos(passEndAngle);
  const passY = cy + radius * Math.sin(passEndAngle);
  const failX = cx + radius * Math.cos(failEndAngle);
  const failY = cy + radius * Math.sin(failEndAngle);

  let paths = '';

  if (passPercent > 0) {
    const startAngle = -Math.PI / 2;
    const startX = cx + radius * Math.cos(startAngle);
    const startY = cy + radius * Math.sin(startAngle);
    if (passPercent === 1) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#4caf50"/>`;
    } else {
      paths += `<path d="M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${passLargeArc} 1 ${passX} ${passY} Z" fill="#4caf50"/>`;
    }
  }

  if (failPercent > 0) {
    if (failPercent === 1) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#f44336"/>`;
    } else {
      const startX = passX;
      const startY = passY;
      paths += `<path d="M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${failLargeArc} 1 ${failX} ${failY} Z" fill="#f44336"/>`;
    }
  }

  if (skipPercent > 0) {
    if (skipPercent === 1) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#9e9e9e"/>`;
    } else {
      const startX = failX;
      const startY = failY;
      const endX = cx + radius * Math.cos(skipEndAngle);
      const endY = cy + radius * Math.sin(skipEndAngle);
      paths += `<path d="M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${skipLargeArc} 1 ${endX} ${endY} Z" fill="#9e9e9e"/>`;
    }
  }

  return `<svg width="150" height="150" viewBox="0 0 150 150">${paths}</svg>`;
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

function generateConsoleReport(results, options = {}) {
  const lines = [];
  const width = 80;
  const separator = '═'.repeat(width);
  const thinSeparator = '─'.repeat(width);

  lines.push('');
  lines.push(separator);
  lines.push(centerText(' API CONTRACT TEST RESULTS ', width, '═'));
  lines.push(separator);
  lines.push('');

  lines.push(`API: ${results.apiInfo?.title || 'Unknown'} v${results.apiInfo?.version || 'N/A'}`);
  lines.push(`Base URL: ${results.baseUrl}`);
  lines.push(`Duration: ${formatDuration(results.duration)}`);
  lines.push('');
  lines.push(thinSeparator);
  lines.push('');

  const passRate = calculatePercentage(results.passed, results.totalTests);
  const statusColor = passRate >= 80 ? '\x1b[32m' : passRate >= 50 ? '\x1b[33m' : '\x1b[31m';
  const resetColor = '\x1b[0m';

  lines.push('📊 SUMMARY');
  lines.push('');
  lines.push(`  Total Endpoints: ${results.totalEndpoints}`);
  lines.push(`  Tested Endpoints: ${results.endpointCoverage?.tested || 0} / ${results.totalEndpoints} (${calculatePercentage(results.endpointCoverage?.tested || 0, results.totalEndpoints)}%)`);
  lines.push(`  Total Tests: ${results.totalTests}`);
  lines.push(`  ✅ Passed: ${results.passed}`);
  lines.push(`  ❌ Failed: ${results.failed}`);
  lines.push(`  ⏭️ Skipped: ${results.skipped}`);
  lines.push(`  ${statusColor}📈 Pass Rate: ${passRate}%${resetColor}`);
  lines.push('');

  lines.push('📋 ENDPOINT STATUS');
  lines.push('');
  
  for (const ep of results.endpointCoverage?.details || []) {
    const statusIcon = ep.status === 'pass' ? '✅' : '❌';
    const methodPad = ep.method.padEnd(7);
    const passFail = `${ep.testsPassed}/${ep.testsTotal}`.padStart(7);
    lines.push(`  ${statusIcon} ${methodPad} ${ep.path.padEnd(30)} [${passFail}]`);
  }
  lines.push('');

  const failedTests = results.testResults.filter(t => t.status === 'fail');
  if (failedTests.length > 0) {
    lines.push(thinSeparator);
    lines.push('');
    lines.push('❌ FAILED TESTS');
    lines.push('');

    for (let i = 0; i < Math.min(failedTests.length, 10); i++) {
      const test = failedTests[i];
      lines.push(`  ${i + 1}. ${test.description}`);
      lines.push(`     ${test.endpoint.method} ${test.endpoint.path}`);
      for (const error of test.errors.slice(0, 2)) {
        lines.push(`        • ${error.message}`);
      }
      lines.push('');
    }

    if (failedTests.length > 10) {
      lines.push(`  ... and ${failedTests.length - 10} more failures`);
      lines.push('');
    }
  }

  lines.push(separator);
  
  if (results.failed === 0 && results.skipped === 0) {
    lines.push(centerText('🎉 ALL TESTS PASSED! ', width, ' '));
  } else if (results.failed === 0) {
    lines.push(centerText('✅ ALL EXECUTED TESTS PASSED ', width, ' '));
  } else {
    lines.push(centerText(` ${results.failed} TEST(S) FAILED `, width, ' '));
  }
  lines.push(separator);
  lines.push('');

  return lines.join('\n');
}

function centerText(text, width, char = ' ') {
  const padLeft = Math.floor((width - text.length) / 2);
  const padRight = width - text.length - padLeft;
  return char.repeat(padLeft) + text + char.repeat(padRight);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(2);
  return `${minutes}m ${seconds}s`;
}

function calculatePercentage(part, total) {
  if (total === 0) return 0;
  return Math.round((part / total) * 100 * 100) / 100;
}

function writeReports(results, outputDir, options = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  const reports = [];

  if (options.junit !== false) {
    const junitContent = generateJUnitXML(results, options);
    const junitPath = path.join(outputDir, `test-results-${timestamp}.xml`);
    fs.writeFileSync(junitPath, junitContent);
    reports.push({ type: 'junit', path: junitPath });
  }

  if (options.markdown !== false) {
    const mdContent = generateMarkdownReport(results, options);
    const mdPath = path.join(outputDir, `test-report-${timestamp}.md`);
    fs.writeFileSync(mdPath, mdContent);
    reports.push({ type: 'markdown', path: mdPath });
  }

  if (options.json !== false) {
    const jsonContent = JSON.stringify(results, null, 2);
    const jsonPath = path.join(outputDir, `test-results-${timestamp}.json`);
    fs.writeFileSync(jsonPath, jsonContent);
    reports.push({ type: 'json', path: jsonPath });
  }

  if (options.html) {
    const htmlContent = generateHTMLReport(results, options);
    const htmlPath = path.join(outputDir, `test-report-${timestamp}.html`);
    fs.writeFileSync(htmlPath, htmlContent);
    reports.push({ type: 'html', path: htmlPath });
  }

  return reports;
}

function saveTestSuite(testSuite, outputDir, options = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `test-suite-${timestamp}.json`);
  
  fs.writeFileSync(outputPath, JSON.stringify(testSuite, null, 2));
  
  return outputPath;
}

function generateStandaloneTestScript(testSuite, baseUrl, outputPath) {
  const scriptContent = `#!/usr/bin/env node
const axios = require('axios');
const Ajv = require('ajv');

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  strictSchema: false,
  formats: {
    email: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/,
    url: /^https?:\\/\\/.+/,
    date: /^\\d{4}-\\d{2}-\\d{2}$/,
    'date-time': /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    int32: true,
    int64: true,
    float: true,
    double: true
  }
});
const BASE_URL = '${baseUrl}';

const testSuite = ${JSON.stringify(testSuite, null, 2)};

async function runTests() {
  console.log('\\n=== API Contract Tests ===\\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testSuite.testCases) {
    console.log(\`Testing: \${testCase.description}\`);
    
    try {
      const url = buildUrl(BASE_URL, testCase.request.path, testCase.request.queryParams);
      
      const response = await axios({
        method: testCase.request.method.toLowerCase(),
        url: url,
        data: testCase.request.body,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
        timeout: 10000
      });
      
      let testPassed = true;
      
      if (testCase.validation.checkStatus && response.status !== testCase.expectedStatus) {
        console.log(\`  ❌ Status mismatch: expected \${testCase.expectedStatus}, got \${response.status}\`);
        testPassed = false;
      }
      
      if (testCase.validation.checkSchema && testCase.expectedSchema) {
        const validate = ajv.compile(testCase.expectedSchema);
        if (!validate(response.data)) {
          console.log('  ❌ Schema validation failed:');
          for (const error of validate.errors || []) {
            console.log(\`    - \${error.instancePath || 'root'}: \${error.message}\`);
          }
          testPassed = false;
        }
      }
      
      if (testPassed) {
        console.log('  ✅ PASSED');
        passed++;
      } else {
        failed++;
      }
      
    } catch (error) {
      console.log(\`  ❌ Error: \${error.message}\`);
      failed++;
    }
    
    console.log('');
  }
  
  console.log('=== Summary ===');
  console.log(\`Total: \${testSuite.totalTests}, Passed: \${passed}, Failed: \${failed}\`);
  console.log(\`Pass Rate: \${Math.round((passed / testSuite.totalTests) * 100)}%\\n\`);
  
  process.exit(failed > 0 ? 1 : 0);
}

function buildUrl(baseUrl, path, queryParams) {
  let url = baseUrl.replace(/\\/$/, '') + path;
  if (queryParams && Object.keys(queryParams).length > 0) {
    const searchParams = new URLSearchParams();
    for (const key in queryParams) {
      if (queryParams[key] !== undefined) {
        searchParams.append(key, String(queryParams[key]));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += '?' + qs;
  }
  return url;
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
`;

  fs.writeFileSync(outputPath, scriptContent);
  fs.chmodSync(outputPath, 0o755);
  
  return outputPath;
}

module.exports = {
  generateJUnitXML,
  generateMarkdownReport,
  generateConsoleReport,
  generateHTMLReport,
  writeReports,
  saveTestSuite,
  generateStandaloneTestScript,
  formatDuration,
  calculatePercentage
};
