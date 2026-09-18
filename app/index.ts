import { registerRootComponent } from 'expo';

import App from './App';
import { defineSchedulerTask } from './src/background/task';

// Before the root component: a background launch loads this bundle, mounts
// nothing, and looks the scheduler task up by name.
defineSchedulerTask();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
