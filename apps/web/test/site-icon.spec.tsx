// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {SiteIcon} from '../src/app/local/SiteIcon';

afterEach(cleanup);

it('uses the linked site favicon before the site Apple Touch icon and then a text fallback',()=>{
  const {container}=render(<SiteIcon url="https://example.org/tools" title="鱼糕"/>);
  const image=()=>container.querySelector<HTMLImageElement>('.local-directory__monogram img');
  expect(image()?.src).toBe('https://example.org/favicon.ico');
  fireEvent.error(image()!);
  expect(image()?.src).toBe('https://example.org/apple-touch-icon.png');
  fireEvent.error(image()!);
  expect(image()).toBeNull();
  expect(screen.getByText('鱼')).toBeDefined();
});

it('prefers the extracted same-site custom favicon and never sends the referring URL',()=>{
  const {container}=render(<SiteIcon url="https://example.org/tool?token=secret"
    title="钓鱼" faviconUrl="https://example.org/static/logo.svg"/>);
  const image=container.querySelector<HTMLImageElement>('img');
  expect(image?.src).toBe('https://example.org/static/logo.svg');
  // JSDOM 不实现 referrerPolicy DOM 属性，检查真实渲染的 HTML 属性。
  expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
});
