import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanNavigationSourceText} from '../lib/navigation-source-text.mjs';

test('navigation snapshot text preserves markup and entity decoding order',()=>{
  assert.equal(cleanNavigationSourceText(' 鱼<b>王</b> &amp; &#x2605; &#9733; &quot; &nbsp; '),'鱼 王 & ★ ★ "');
  assert.equal(cleanNavigationSourceText('&lt;b&gt; &#60;b&#62;'),'&lt;b&gt; <b>');
  assert.equal(cleanNavigationSourceText('a<incomplete'),'a<incomplete');
  assert.equal(cleanNavigationSourceText('a<x<y>z>'),'a z>');
});

test('navigation snapshot text scans long incomplete tags without discarding text',()=>{
  const incomplete='<'.repeat(100_000);
  assert.equal(cleanNavigationSourceText(incomplete),incomplete);
  assert.equal(cleanNavigationSourceText(incomplete+'>鱼'),'鱼');
});
