#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const parser = require('./lib/parser');
const testGenerator = require('./lib/testGenerator');
const testRunner = require('./lib/testRunner');
const reporter = require('./lib/reporter');
const auth = require('./lib/auth');
const { mergeAuthOptions } = require('./lib/auth');
const differ = require('./lib/differ');

const program = new Command();

let lastResults = null;

function openInBrowser(filePath) {
  const absolutePath = path.resolve(filePath);
  const fileUrl = 'file://' + absolutePath;
  
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync(`open "${fileUrl}"`);
    } else if (platform === 'win32') {
      execSync(`start "" "${fileUrl}"`);
    } else {
      execSync(`xdg-open "${fileUrl}"`);
    }
    return true;
  } catch (error) {
    console.error('⚠️  Failed to open browser:', error.message);
    return false;
  }
}

program
  .name('apicontract')
  .description('OpenAPI/Swagger based API contract testing CLI tool')
  .version('1.0.0');

program
  .command('generate <openapiFile>')
  .description('Generate test cases from OpenAPI specification')
  .option('-o, --output <directory>', 'Output directory for generated tests', 'tests/')
  .option('--dry-run', 'Only generate tests without saving')
  .option('--standalone', 'Generate standalone JavaScript test file')
  .option('--base-url <url>', 'Base URL for standalone script')
  .action(async (openapiFile, options) => {
    try {
      console.log('\n📄 Parsing OpenAPI specification...');
      const parsedAPI = parser.parseOpenAPI(openapiFile);
      
      console.log(`✅ Found ${parsedAPI.endpoints.length} endpoints from ${parsedAPI.info.title} v${parsedAPI.info.version}`);
      
      console.log('\n🔧 Generating test cases...');
      const testSuite = testGenerator.generateAllTests(parsedAPI);
      
      console.log(`✅ Generated ${testSuite.totalTests} test cases for ${testSuite.totalEndpoints} endpoints`);
      
      for (const endpoint of parsedAPI.endpoints) {
        const method = endpoint.method.padEnd(7);
        console.log(`   ${method} ${endpoint.path}`);
      }
      
      if (options.dryRun) {
        console.log('\n⏭️ Dry run - not saving files');
        lastResults = testSuite;
        return;
      }
      
      const outputDir = path.resolve(options.output);
      
      if (options.standalone) {
        const baseUrl = options.baseUrl || (parsedAPI.servers[0]?.url || 'http://localhost:3000');
        const standalonePath = path.join(outputDir, 'api-contract-tests.js');
        const savedPath = reporter.generateStandaloneTestScript(testSuite, baseUrl, standalonePath);
        console.log(`\n💾 Generated standalone test file: ${savedPath}`);
        console.log(`   Run with: node ${savedPath}`);
      } else {
        const suitePath = reporter.saveTestSuite(testSuite, outputDir);
        console.log(`\n💾 Test suite saved to: ${suitePath}`);
      }
      
      const testListPath = path.join(outputDir, 'test-cases.json');
      fs.writeFileSync(testListPath, JSON.stringify(testSuite, null, 2));
      console.log(`💾 Test cases saved to: ${testListPath}`);
      
      lastResults = testSuite;
      
      console.log('\n🎉 Generation complete!');
      
    } catch (error) {
      console.error('\n❌ Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('run <openapiFile>')
  .description('Run API contract tests against a base URL')
  .option('--base-url <url>', 'Base URL of the API', 'http://localhost:3000')
  .option('-o, --output <directory>', 'Output directory for reports', 'tests/')
  .option('--dry-run', 'Generate tests but do not execute')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '10000')
  .option('--no-junit', 'Disable JUnit XML report')
  .option('--no-markdown', 'Disable Markdown report')
  .option('--no-json', 'Disable JSON report')
  .option('--filter <pattern>', 'Filter tests by pattern')
  .option('--auth-type <type>', 'Authentication type: bearer, basic, apikey')
  .option('--auth-token <token>', 'Bearer token for bearer auth')
  .option('--auth-user <user>', 'Username for basic auth')
  .option('--auth-pass <pass>', 'Password for basic auth')
  .option('--auth-key <key>', 'API key for apikey auth')
  .option('--auth-header <header-name>', 'Header name for apikey auth', 'X-API-Key')
  .option('--auth-config <file>', 'JSON file with auth configuration')
  .option('--isolated', 'Enable isolated test data with setup/teardown')
  .option('--plugins <dir>', 'Directory containing plugin files (can be used multiple times)', (val, arr) => { arr.push(val); return arr; }, [])
  .option('--html', 'Generate HTML report')
  .option('--open', 'Open report in browser after generation')
  .action(async (openapiFile, options) => {
    try {
      console.log('\n📄 Parsing OpenAPI specification...');
      const parsedAPI = parser.parseOpenAPI(openapiFile);
      
      console.log(`✅ Found ${parsedAPI.endpoints.length} endpoints from ${parsedAPI.info.title} v${parsedAPI.info.version}`);
      
      console.log('\n🔧 Generating test cases...');
      const testSuite = testGenerator.generateAllTests(parsedAPI);
      
      if (options.filter) {
        const pattern = new RegExp(options.filter, 'i');
        testSuite.testCases = testSuite.testCases.filter(t => 
          pattern.test(t.description) || pattern.test(t.endpoint.path) || pattern.test(t.endpoint.method)
        );
        testSuite.totalTests = testSuite.testCases.length;
        console.log(`✅ Filtered to ${testSuite.totalTests} test cases`);
      } else {
        console.log(`✅ Generated ${testSuite.totalTests} test cases`);
      }
      
      if (options.dryRun) {
        console.log('\n⏭️ Dry run - tests not executed');
        console.log('\n📋 Test cases:');
        for (const test of testSuite.testCases) {
          console.log(`   • ${test.description}`);
        }
        return;
      }
      
      console.log(`\n🚀 Running tests against ${options.baseUrl}...`);
      console.log(`⏱️  Timeout: ${options.timeout}ms`);
      
      const authOpts = mergeAuthOptions(options);
      if (authOpts.authType) {
        console.log(`🔐 Auth type: ${authOpts.authType}`);
      }
      if (options.plugins && options.plugins.length > 0) {
        console.log(`🔌 Plugins: ${options.plugins.join(', ')}`);
      }
      console.log('');
      
      const results = await testRunner.runAllTests(testSuite, options.baseUrl, {
        timeout: parseInt(options.timeout),
        authType: authOpts.authType,
        authToken: authOpts.authToken,
        authUser: authOpts.authUser,
        authPass: authOpts.authPass,
        authKey: authOpts.authKey,
        authHeader: authOpts.authHeader,
        isolated: options.isolated,
        plugins: options.plugins,
        beforeEachTest: async (testCase) => {
          const statusIcon = testCase.type === 'success' ? '✨' : testCase.type === 'not_found' ? '🔍' : '⚠️ ';
          process.stdout.write(`  ${statusIcon} ${testCase.description}... `);
        },
        afterEachTest: async (testCase, result) => {
          if (result.status === 'pass') {
            console.log('✅ PASS');
          } else {
            console.log('❌ FAIL');
            for (const error of result.errors.slice(0, 2)) {
              console.log(`       ${error.message}`);
            }
          }
        }
      });
      
      console.log('\n' + reporter.generateConsoleReport(results));
      
      lastResults = results;
      
      const outputDir = path.resolve(options.output);
      const reports = reporter.writeReports(results, outputDir, {
        junit: options.junit,
        markdown: options.markdown,
        json: options.json,
        html: options.html,
        suiteName: `${parsedAPI.info.title} - Contract Tests`
      });
      
      console.log('\n📊 Reports generated:');
      for (const report of reports) {
        console.log(`   • ${report.type.toUpperCase()}: ${report.path}`);
      }
      
      if (options.open) {
        const htmlReport = reports.find(r => r.type === 'html');
        if (htmlReport) {
          console.log('\n🌐 Opening HTML report in browser...');
          openInBrowser(htmlReport.path);
        } else {
          console.log('\n⚠️  No HTML report generated. Use --html to generate HTML report.');
        }
      }
      
      const exitCode = results.failed > 0 ? 1 : 0;
      
      if (results.failed > 0) {
        console.log(`\n⚠️  Some tests failed. Exit code: ${exitCode}`);
      } else {
          console.log(`\n🎉 All tests passed! Exit code: ${exitCode}`);
      }
      
      process.exit(exitCode);
      
    } catch (error) {
      console.error('\n❌ Error:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
  });

program
  .command('report')
  .description('Generate reports from test results')
  .option('-i, --input <file>', 'Input test results JSON file')
  .option('-o, --output <directory>', 'Output directory for reports', 'tests/')
  .option('--junit', 'Generate JUnit XML report')
  .option('--markdown', 'Generate Markdown report')
  .option('--json', 'Generate JSON report')
  .option('--html', 'Generate HTML report')
  .option('--all', 'Generate all report formats', true)
  .option('--open', 'Open HTML report in browser after generation')
  .action(async (options) => {
    try {
      let results = null;
      
      if (options.input) {
        const inputPath = path.resolve(options.input);
        if (!fs.existsSync(inputPath)) {
          console.error(`❌ Input file not found: ${inputPath}`);
          process.exit(1);
        }
        results = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      } else if (lastResults && lastResults.testResults) {
        results = lastResults;
      } else {
        console.error('❌ No test results available. Run tests first or specify --input');
        process.exit(1);
      }
      
      console.log('\n📊 Generating reports...');
      
      const outputDir = path.resolve(options.output);
      const reports = reporter.writeReports(results, outputDir, {
        junit: options.all || options.junit,
        markdown: options.all || options.markdown,
        json: options.all || options.json,
        html: options.html
      });
      
      console.log('\n✅ Reports generated:');
      for (const report of reports) {
        console.log(`   • ${report.type.toUpperCase()}: ${report.path}`);
      }
      
      if (options.open) {
        const htmlReport = reports.find(r => r.type === 'html');
        if (htmlReport) {
          console.log('\n🌐 Opening HTML report in browser...');
          openInBrowser(htmlReport.path);
        } else {
          console.log('\n⚠️  No HTML report generated. Use --html to generate HTML report.');
        }
      }
      
      console.log('');
      
    } catch (error) {
      console.error('\n❌ Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('list <openapiFile>')
  .description('List all endpoints in the OpenAPI specification')
  .option('--with-tests', 'Show test cases for each endpoint')
  .action((openapiFile, options) => {
    try {
      console.log('\n📄 Parsing OpenAPI specification...');
      const parsedAPI = parser.parseOpenAPI(openapiFile);
      
      console.log(`\n📋 API: ${parsedAPI.info.title} v${parsedAPI.info.version}`);
      console.log(`📝 Description: ${parsedAPI.info.description || 'N/A'}`);
      console.log(`🔗 Servers: ${parsedAPI.servers.map(s => s.url).join(', ')}`);
      console.log(`\n📦 Total Endpoints: ${parsedAPI.endpoints.length}`);
      console.log('');
      
      const byTag = {};
      for (const endpoint of parsedAPI.endpoints) {
        const tags = endpoint.tags.length > 0 ? endpoint.tags : ['default'];
        for (const tag of tags) {
          if (!byTag[tag]) byTag[tag] = [];
          byTag[tag].push(endpoint);
        }
      }
      
      for (const [tag, endpoints] of Object.entries(byTag)) {
        console.log(`🏷️  ${tag.toUpperCase()} (${endpoints.length})`);
        for (const endpoint of endpoints) {
          const method = endpoint.method.padEnd(7);
          console.log(`   ${method} ${endpoint.path}`);
          if (endpoint.summary) {
            console.log(`      ${endpoint.summary}`);
          }
          if (options.withTests) {
            const tests = testGenerator.generateTestsForEndpoint(endpoint);
            console.log(`      🧪 ${tests.length} test cases:`);
            for (const test of tests) {
              console.log(`         • ${test.type}: ${test.description}`);
            }
          }
          console.log('');
        }
      }
      
    } catch (error) {
      console.error('\n❌ Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('validate <openapiFile>')
  .description('Validate the OpenAPI specification')
  .action((openapiFile) => {
    try {
      console.log('\n🔍 Validating OpenAPI specification...');
      const parsedAPI = parser.parseOpenAPI(openapiFile);
      
      console.log('✅ OpenAPI version:', parsedAPI.openapiVersion);
      console.log('✅ API Info:', parsedAPI.info.title, 'v' + parsedAPI.info.version);
      console.log('✅ Endpoints:', parsedAPI.endpoints.length);
      console.log('✅ Schemas:', Object.keys(parsedAPI.schemas).length);
      console.log('✅ Servers:', parsedAPI.servers.length);
      
      let issues = [];
      
      for (const endpoint of parsedAPI.endpoints) {
        if (!endpoint.responses || Object.keys(endpoint.responses).length === 0) {
          issues.push(`⚠️  ${endpoint.method} ${endpoint.path}: No responses defined`);
        }
        
        if (endpoint.parameters.path.some(p => !p.required)) {
          issues.push(`⚠️  ${endpoint.method} ${endpoint.path}: Path parameter not marked as required`);
        }
      }
      
      if (issues.length > 0) {
        console.log('\n⚠️  Warnings:');
        for (const issue of issues) {
          console.log(issue);
        }
      }
      
      console.log('\n🎉 Specification is valid!');
      
    } catch (error) {
      console.error('\n❌ Validation failed:', error.message);
      process.exit(1);
    }
  });

program
  .command('auth')
  .description('Verify authentication configuration')
  .option('--base-url <url>', 'Base URL of the API', 'http://localhost:3000')
  .option('--auth-type <type>', 'Authentication type: bearer, basic, apikey')
  .option('--auth-token <token>', 'Bearer token for bearer auth')
  .option('--auth-user <user>', 'Username for basic auth')
  .option('--auth-pass <pass>', 'Password for basic auth')
  .option('--auth-key <key>', 'API key for apikey auth')
  .option('--auth-header <header-name>', 'Header name for apikey auth', 'X-API-Key')
  .option('--auth-config <file>', 'JSON file with auth configuration')
  .action(async (options) => {
    try {
      console.log('\n🔐 Verifying authentication configuration...');
      console.log(`📍 Base URL: ${options.baseUrl}`);
      
      const authOpts = mergeAuthOptions(options);
      
      if (!authOpts.authType) {
        console.log('\n⚠️  No auth type specified. Use --auth-type to specify: bearer, basic, apikey');
        console.log('');
        console.log('Examples:');
        console.log('  apicontract auth --auth-type bearer --auth-token mytoken');
        console.log('  apicontract auth --auth-type basic --auth-user admin --auth-pass secret');
        console.log('  apicontract auth --auth-type apikey --auth-key mykey --auth-header X-API-Key');
        console.log('  apicontract auth --auth-config auth.json');
        process.exit(1);
      }
      
      console.log(`🔑 Auth type: ${authOpts.authType}`);
      console.log('');
      console.log('📡 Sending HEAD request to /admin/stats...');
      
      const result = await auth.verifyAuth(options.baseUrl, authOpts);
      
      console.log('');
      
      if (result.error) {
        console.log('❌ Connection error:', result.error);
        process.exit(1);
      }
      
      console.log(`📊 Response status: ${result.status}`);
      console.log('');
      
      if (result.authorized) {
        console.log('✅ Authentication successful!');
        console.log('   The credentials are valid.');
      } else if (result.status === 401 || result.status === 403) {
        console.log('❌ Authentication failed!');
        console.log('   Server returned 401/403 - check your credentials.');
        process.exit(1);
      } else if (result.status === 404) {
        console.log('⚠️  /admin/stats endpoint not found (404)');
        console.log('   The auth endpoint may not be available on this server.');
        process.exit(1);
      } else {
        console.log(`⚠️  Unexpected response: ${result.status}`);
      }
      
      console.log('');
      
    } catch (error) {
      console.error('\n❌ Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('diff <openapiV1> <openapiV2>')
  .description('Compare two OpenAPI specification versions')
  .option('-f, --format <format>', 'Output format: console, json, markdown', 'console')
  .option('-o, --output <file>', 'Output file (for json/markdown formats)')
  .action((openapiV1, openapiV2, options) => {
    try {
      console.log('\n📄 Comparing OpenAPI specifications...');
      console.log(`   V1: ${openapiV1}`);
      console.log(`   V2: ${openapiV2}`);
      console.log('');
      
      const diffResult = differ.compareOpenAPI(openapiV1, openapiV2);
      
      const output = differ.formatDiff(diffResult, options.format);
      
      if (options.output) {
        const outputPath = path.resolve(options.output);
        fs.writeFileSync(outputPath, output);
        console.log(`💾 Diff report saved to: ${outputPath}`);
      } else {
        console.log(output);
      }
      
      if (diffResult.breakingChanges > 0) {
        console.log(`⚠️  Found ${diffResult.breakingChanges} breaking change(s)`);
      }
      
    } catch (error) {
      console.error('\n❌ Error:', error.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

if (process.argv.slice(2).length === 0) {
  program.outputHelp();
}
