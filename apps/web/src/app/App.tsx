import { LocalApp } from './local/LocalApp';

/** Personal data and settings are browser-local; public content remains read-only HTTP. */
export function App() {
  return <LocalApp />;
}
