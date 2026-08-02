// AsyncStorage is a native module, so any module that imports it (the local
// stores, the demo core's identity cache, the legacy-key migration) would throw
// on require under jest. This is the mock the package ships for exactly that.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
