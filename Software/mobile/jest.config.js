module.exports = {
  preset: '@react-native/jest-preset',
  testPathIgnorePatterns: ['/node_modules/', '/ios/Pods/', '/android/app/build/'],
  // React Navigation publishes ESM under lib/module. Keep these packages in
  // Babel's transform path so Jest can execute the same navigation stack that
  // Metro uses in the app.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|query-string|decode-uri-component|filter-obj|split-on-first|react-native-screens|react-native-gesture-handler|react-native-safe-area-context)/)',
  ],
  moduleNameMapper: {
    '^query-string$': '<rootDir>/src/compat/query-string.js',
    '^react-native-geolocation-service$': '<rootDir>/__mocks__/geolocationService.js',
    '^@maplibre/maplibre-react-native$': '<rootDir>/__mocks__/mapLibre.js',
    '^react-native-image-picker$': '<rootDir>/__mocks__/imagePicker.js',
    '\\.(ttf)$': '<rootDir>/__mocks__/fontMock.js',
  },
};
