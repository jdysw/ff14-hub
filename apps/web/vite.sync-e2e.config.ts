import {defineConfig} from 'vite';
// A separate, ignored fixture bundle. Production build never serves this test entry point.
export default defineConfig({build:{
  target:'es2022',outDir:'../../.wrangler/phase06c-fixture',emptyOutDir:true,minify:false,
  lib:{entry:'../../tests/e2e/sync-runtime.fixture.ts',formats:['es'],fileName:()=> 'sync-runtime.js'},
}});
