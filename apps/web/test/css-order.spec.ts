import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';

/**
 * 拆分前的 modern-ui.css 级联顺序属于已验证的视觉契约；
 * 新样式文件必须在 field-guide.css 之前，避免样式优先级悄然变化。
 */
it('keeps the modern stylesheets in the original cascade order',()=>{
  const entry=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');
  const sequence=[
    './app/local/modern-ui.css',
    './app/local/modern-content.css',
    './app/local/modern-components.css',
    './app/pvp/pvp-panel.css',
    './app/local/field-guide.css',
  ];
  const positions=sequence.map(path=>entry.indexOf("import '"+path+"';"));
  expect(positions.every(position=>position>=0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a,b)=>a-b));
  for(const path of sequence){
    expect(readFileSync(new URL('../src/'+path.replace(/^\.\//,''),import.meta.url),'utf8').length).toBeGreaterThan(0);
  }
});
