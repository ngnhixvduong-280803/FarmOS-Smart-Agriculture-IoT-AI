/**
 * @format
 */


// Supabase mutates URL fields while deriving its service endpoints. React
// Native's built-in URL object exposes those fields as readonly, so install the
// standards-compatible polyfill before importing any application module.
import 'react-native-url-polyfill/auto';
import './src/polyfills/webCrypto';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
