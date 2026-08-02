// Added for react-native-reanimated 4 / react-native-worklets. The worklets
// Babel plugin rewrites the animation worklets and MUST be listed last.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
