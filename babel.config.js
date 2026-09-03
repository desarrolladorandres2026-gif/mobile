module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // El plugin de worklets debe ir siempre último: reescribe las funciones
    // marcadas como worklet (useAnimatedStyle, useAnimatedProps, etc.) para
    // que corran en el hilo de UI. Sin esto, react-native-reanimated no
    // lanza error: simplemente no anima nada, se queda estática.
    plugins: ['react-native-worklets/plugin'],
  };
};
