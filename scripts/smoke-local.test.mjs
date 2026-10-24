import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smokeBaseUrl, safeLogText } from './smoke-local.mjs';

test('冒烟探测只允许本机 HTTP 目标，不访问用户输入的远端', () => {
  assert.equal(smokeBaseUrl(), 'http://127.0.0.1:8787');
  assert.equal(smokeBaseUrl('http://localhost:9876/'), 'http://localhost:9876');
  for (const unsafe of [
    'https://example.com', 'http://192.168.1.10:8787',
    'http://127.0.0.1:8787/api/v1/admin', 'http://localhost:8787/?token=x',
    'http://user:pass@localhost:8787/', 'file:///etc/passwd',
    'http://localhost:8787/#frag',
  ]) {
    assert.throws(() => smokeBaseUrl(unsafe), unsafe);
  }
});

test('诊断日志转义控制字符并限制长度', () => {
  const line = safeLogText('bad\r\n[PASS] forged\t' + 'x'.repeat(400));
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('\r'), false);
  assert.equal(line.length, 180);
  assert.ok(line.startsWith('bad\\r\\n'));
});
