const fs = require('fs');
const path = require('path');

class PluginManager {
  constructor() {
    this.plugins = [];
  }

  loadPlugins(pluginDir) {
    const absoluteDir = path.resolve(pluginDir);
    
    if (!fs.existsSync(absoluteDir)) {
      return [];
    }

    const files = fs.readdirSync(absoluteDir).filter(f => f.endsWith('.js'));
    
    for (const file of files) {
      try {
        const pluginPath = path.join(absoluteDir, file);
        const plugin = require(pluginPath);
        plugin.name = plugin.name || file.replace('.js', '');
        this.plugins.push(plugin);
      } catch (error) {
        console.warn(`⚠️  Failed to load plugin ${file}: ${error.message}`);
      }
    }

    return this.plugins;
  }

  async beforeAll(testSuite) {
    for (const plugin of this.plugins) {
      if (typeof plugin.beforeAll === 'function') {
        try {
          await plugin.beforeAll(testSuite);
        } catch (error) {
          console.warn(`⚠️  Plugin ${plugin.name} beforeAll failed: ${error.message}`);
        }
      }
    }
  }

  async afterAll(results) {
    for (const plugin of this.plugins) {
      if (typeof plugin.afterAll === 'function') {
        try {
          await plugin.afterAll(results);
        } catch (error) {
          console.warn(`⚠️  Plugin ${plugin.name} afterAll failed: ${error.message}`);
        }
      }
    }
  }

  async beforeEach(testCase) {
    let currentTestCase = { ...testCase };
    
    for (const plugin of this.plugins) {
      if (typeof plugin.beforeEach === 'function') {
        try {
          const result = await plugin.beforeEach(currentTestCase);
          if (result !== undefined) {
            currentTestCase = result;
          }
        } catch (error) {
          console.warn(`⚠️  Plugin ${plugin.name} beforeEach failed: ${error.message}`);
        }
      }
    }
    
    return currentTestCase;
  }

  async afterEach(testCase, result) {
    for (const plugin of this.plugins) {
      if (typeof plugin.afterEach === 'function') {
        try {
          await plugin.afterEach(testCase, result);
        } catch (error) {
          console.warn(`⚠️  Plugin ${plugin.name} afterEach failed: ${error.message}`);
        }
      }
    }
  }

  getPluginCount() {
    return this.plugins.length;
  }

  getPluginNames() {
    return this.plugins.map(p => p.name || 'unknown');
  }
}

function createPluginManager() {
  return new PluginManager();
}

module.exports = {
  PluginManager,
  createPluginManager
};
