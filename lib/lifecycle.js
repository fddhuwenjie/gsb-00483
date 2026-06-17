const axios = require('axios');
const mockGenerator = require('./mockGenerator');
const parser = require('./parser');

class LifecycleManager {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.isolated = options.isolated || false;
    this.timeout = options.timeout || 10000;
    this.authOptions = options.authOptions || {};
    this.endpoints = options.endpoints || [];
  }

  buildAuthHeaders() {
    const { buildAuthHeaders } = require('./auth');
    return buildAuthHeaders(this.authOptions);
  }

  async setup(testCase) {
    if (!this.isolated) return { testCase, createdResources: [] };

    const endpoint = testCase.endpoint;
    const method = endpoint.method;
    const createdResources = [];

    if (testCase.type !== 'success') {
      return { testCase, createdResources };
    }

    if (method === 'GET' && endpoint.parameters.path.length > 0) {
      const { resource, dependencies } = await this.createResourceForGet(endpoint);
      if (resource) {
        testCase = this.updateTestCaseWithResource(testCase, resource, endpoint);
        const resourceType = this.getResourceType(endpoint.path);
        createdResources.push({
          path: this.getCollectionPath(endpoint.path),
          idField: this.getIdField(resourceType),
          id: resource[this.getIdField(resourceType)],
          resource
        });
        if (dependencies && dependencies.length > 0) {
          createdResources.push(...dependencies);
        }
      }
    }

    if (method === 'PUT' || method === 'DELETE') {
      const { resource, dependencies } = await this.createResourceForEndpoint(endpoint);
      if (resource) {
        testCase = this.updateTestCaseWithResource(testCase, resource, endpoint);
        const resourceType = this.getResourceType(endpoint.path);
        createdResources.push({
          path: this.getCollectionPath(endpoint.path),
          idField: this.getIdField(resourceType),
          id: resource[this.getIdField(resourceType)],
          resource
        });
        if (dependencies && dependencies.length > 0) {
          createdResources.push(...dependencies);
        }
      }
    }

    return { testCase, createdResources };
  }

  async teardown(testCase, result, createdResources = []) {
    if (!this.isolated) return;

    for (let i = createdResources.length - 1; i >= 0; i--) {
      try {
        await this.deleteResource(createdResources[i]);
      } catch (e) {
      }
    }
  }

  async createResourceForGet(endpoint) {
    const resourceType = this.getResourceType(endpoint.path);
    if (!resourceType) return { resource: null, dependencies: [] };

    const collectionPath = this.getCollectionPath(endpoint.path);
    if (!collectionPath) return { resource: null, dependencies: [] };

    return await this.createResourceByPost(collectionPath, endpoint);
  }

  async createResourceForEndpoint(endpoint) {
    const resourceType = this.getResourceType(endpoint.path);
    if (!resourceType) return { resource: null, dependencies: [] };

    const collectionPath = this.getCollectionPath(endpoint.path);
    if (!collectionPath) return { resource: null, dependencies: [] };

    return await this.createResourceByPost(collectionPath, endpoint);
  }

  getResourceType(path) {
    if (path.includes('/pets')) return 'pet';
    if (path.includes('/orders')) return 'order';
    if (path.includes('/users')) return 'user';
    return null;
  }

  getCollectionPath(path) {
    if (path.startsWith('/pets/')) return '/pets';
    if (path.startsWith('/orders/')) return '/orders';
    if (path.startsWith('/users/')) return '/users';
    return null;
  }

  async createResourceByPost(collectionPath, endpoint) {
    try {
      const bodySchema = this.getCreateSchema(endpoint);
      if (!bodySchema) return { resource: null, dependencies: [] };

      let body = mockGenerator.generateFromSchema(bodySchema, true, true);
      const dependencies = [];

      const resourceType = this.getResourceType(collectionPath);
      
      if (resourceType === 'pet') {
        delete body.id;
      } else if (resourceType === 'order') {
        const pet = await this.createPetForOrder();
        if (pet) {
          body.petId = pet.id;
          dependencies.push({
            path: '/pets',
            idField: 'id',
            id: pet.id,
            resource: pet
          });
        } else {
          body.petId = 1;
        }
        delete body.id;
      } else if (resourceType === 'user') {
        const timestamp = Date.now().toString().slice(-8);
        body.username = `iso_${timestamp}`;
        body.email = `iso_${timestamp}@example.com`;
        delete body.id;
      }

      const authHeaders = this.buildAuthHeaders();
      const url = this.baseUrl.replace(/\/$/, '') + collectionPath;

      const response = await axios({
        method: 'post',
        url: url,
        data: body,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        validateStatus: () => true,
        timeout: this.timeout
      });

      if (response.status >= 200 && response.status < 300) {
        const resource = response.data;
        return { resource, dependencies };
      }

      return { resource: null, dependencies };
    } catch (error) {
      return { resource: null, dependencies: [] };
    }
  }

  async createPetForOrder() {
    try {
      const petEndpoint = this.findPostEndpoint('/pets');
      if (!petEndpoint) return null;

      const bodySchema = this.getCreateSchema(petEndpoint);
      if (!bodySchema) return null;

      let body = mockGenerator.generateFromSchema(bodySchema, true, true);
      delete body.id;

      const authHeaders = this.buildAuthHeaders();
      const url = this.baseUrl.replace(/\/$/, '') + '/pets';

      const response = await axios({
        method: 'post',
        url: url,
        data: body,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        validateStatus: () => true,
        timeout: this.timeout
      });

      if (response.status >= 200 && response.status < 300) {
        return response.data;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  getIdField(resourceType) {
    if (resourceType === 'user') return 'username';
    return 'id';
  }

  getCreateSchema(endpoint) {
    if (endpoint.requestBody) {
      return parser.getRequestBodySchema(endpoint.requestBody);
    }

    const collectionPath = this.getCollectionPath(endpoint.path);
    if (collectionPath) {
      const postEndpoint = this.findPostEndpoint(collectionPath);
      if (postEndpoint && postEndpoint.requestBody) {
        return parser.getRequestBodySchema(postEndpoint.requestBody);
      }
    }

    return null;
  }

  findPostEndpoint(collectionPath) {
    return this.endpoints.find(
      ep => ep.method === 'POST' && ep.path === collectionPath
    );
  }

  updateTestCaseWithResource(testCase, resource, endpoint) {
    const resourceType = this.getResourceType(endpoint.path);
    const idField = this.getIdField(resourceType);
    const resourceId = resource[idField];

    const pathParams = { ...testCase.request.pathParams };
    const pathParamNames = endpoint.parameters.path.map(p => p.name);
    
    if (pathParamNames.length > 0 && resourceId !== undefined) {
      pathParams[pathParamNames[0]] = resourceId;
    }

    let requestPath = endpoint.path;
    for (const key in pathParams) {
      requestPath = requestPath.replace(`{${key}}`, pathParams[key]);
    }

    return {
      ...testCase,
      request: {
        ...testCase.request,
        pathParams,
        path: requestPath
      }
    };
  }

  async deleteResource(resourceInfo) {
    try {
      const authHeaders = this.buildAuthHeaders();
      const url = this.baseUrl.replace(/\/$/, '') + resourceInfo.path + '/' + resourceInfo.id;

      await axios({
        method: 'delete',
        url: url,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        validateStatus: () => true,
        timeout: this.timeout
      });
    } catch (error) {
    }
  }

  async beforeAll(testSuite) {
  }

  async afterAll(results) {
  }
}

function createLifecycleManager(baseUrl, options = {}) {
  return new LifecycleManager(baseUrl, options);
}

module.exports = {
  LifecycleManager,
  createLifecycleManager
};
