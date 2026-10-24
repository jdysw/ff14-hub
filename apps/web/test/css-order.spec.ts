import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';

/**
 * 拆分前的 modern-ui.css 级联顺序属于已验证的视觉契约；
 * 基础层保持原序，首页轻卡片作为明确的最终覆盖层。
 */
it('keeps the modern stylesheets in the original cascade order',()=>{
  const entry=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');
  const sequence=[
    './app/local/modern-ui.css',
    './app/local/modern-content.css',
    './app/local/modern-components.css',
    './app/pvp/pvp-panel.css',
    './app/local/field-guide.css',
    './app/local/home-cards.css',
  ];
  const positions=sequence.map(path=>entry.indexOf("import '"+path+"';"));
  expect(positions.every(position=>position>=0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a,b)=>a-b));
  for(const path of sequence){
    expect(readFileSync(new URL('../src/'+path.replace(/^\.\//,''),import.meta.url),'utf8').length).toBeGreaterThan(0);
  }
});
