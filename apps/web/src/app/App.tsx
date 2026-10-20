import { LocalApp } from './local/LocalApp';
import {RenderErrorBoundary} from '../lib/RenderErrorBoundary';

/** Personal data and settings are browser-local; public content remains read-only HTTP. */
export function App() {
  return <RenderErrorBoundary><LocalApp /></RenderErrorBoundary>;
}
