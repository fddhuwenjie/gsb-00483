const fs = require('fs');
const path = require('path');

function loadAuthConfig(configFile) {
  const absolutePath = path.resolve(configFile);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Auth config file not found: ${absolutePath}`);
  }
  const content = fs.readFileSync(absolutePath, 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in auth config file: ${error.message}`);
  }
}

function buildAuthHeaders(options) {
  const headers = {};
  const authType = options.authType;

  if (!authType) {
    return headers;
  }

  switch (authType) {
    case 'bearer':
      if (!options.authToken) {
        throw new Error('Bearer auth requires --auth-token');
      }
      headers['Authorization'] = `Bearer ${options.authToken}`;
      break;

    case 'basic':
      if (!options.authUser || !options.authPass) {
        throw new Error('Basic auth requires --auth-user and --auth-pass');
      }
      const credentials = `${options.authUser}:${options.authPass}`;
      const encoded = Buffer.from(credentials).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;

    case 'apikey':
      if (!options.authKey) {
        throw new Error('API key auth requires --auth-key');
      }
      const headerName = options.authHeader || 'X-API-Key';
      headers[headerName] = options.authKey;
      break;

    default:
      throw new Error(`Unknown auth type: ${authType}. Supported: bearer, basic, apikey`);
  }

  return headers;
}

function mergeAuthOptions(cliOptions) {
  let options = { ...cliOptions };

  if (cliOptions.authConfig) {
    const fileConfig = loadAuthConfig(cliOptions.authConfig);
    options = { ...fileConfig, ...options };
  }

  return options;
}

async function verifyAuth(baseUrl, options) {
  const axios = require('axios');
  const headers = buildAuthHeaders(options);

  try {
    const response = await axios({
      method: 'HEAD',
      url: baseUrl.replace(/\/$/, '') + '/admin/stats',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      validateStatus: () => true,
      timeout: 10000
    });

    const isUnauthorized = response.status === 401 || response.status === 403;
    const isAuthorized = response.status >= 200 && response.status < 300;

    return {
      status: response.status,
      authorized: isAuthorized,
      requiresAuth: isUnauthorized || isAuthorized,
      headers: response.headers
    };
  } catch (error) {
    return {
      status: null,
      authorized: false,
      requiresAuth: false,
      error: error.message
    };
  }
}

module.exports = {
  buildAuthHeaders,
  loadAuthConfig,
  mergeAuthOptions,
  verifyAuth
};
