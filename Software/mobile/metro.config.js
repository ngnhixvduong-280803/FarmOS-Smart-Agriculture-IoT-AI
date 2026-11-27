const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const queryStringCompat = path.join(__dirname, 'src/compat/query-string.js');
const config = {
  resolver: {
    // React Navigation imports query-string as a namespace. query-string 9's
    // public entry point is default-only, while base.js retains the named API.
    // The local shim preserves both forms for Navigation and app code.
    resolveRequest(context, moduleName, platform) {
      if (moduleName === 'query-string') {
        return { type: 'sourceFile', filePath: queryStringCompat };
      }

      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
