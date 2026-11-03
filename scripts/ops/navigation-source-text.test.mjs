import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanNavigationSourceText} from '../lib/navigation-source-text.mjs';
import {applyNavigationReview} from '../lib/navigation-review.mjs';
import catalog from '../../data/navigation/catalog.json' with {type:'json'};
import review from '../../data/navigation/review.json' with {type:'json'};

test('navigation review survives reimport and does not mutate or duplicate the retained snapshot',()=>{
 assert.equal(review.entries.length,197);
 assert.deepEqual(applyNavigationReview(catalog,review),catalog);
 const decision=review.entries.find(entry=>entry.decision==='merge');
 const original={...catalog.find(entry=>entry.id===decision.mergedInto),id:decision.id,title:decision.title,url:decision.url,aliases:[],sources:[]};
 const rebuilt=applyNavigationReview([...catalog,original],review);
 assert.equal(rebuilt.some(entry=>entry.id===decision.id),false);
 assert.equal(rebuilt.filter(entry=>entry.id===decision.mergedInto).length,1);
 assert.equal(original.id,decision.id);
 assert.deepEqual(applyNavigationReview([{...catalog[0],id:'new-plugin',category:'插件与开发 / 开发与数据'}],review),[]);
});

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
