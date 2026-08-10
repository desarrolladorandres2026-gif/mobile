import { registerRootComponent } from 'expo';

import App from './app';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a na tive build,
// the environment is set up appropriately
registerRootComponent(App);
