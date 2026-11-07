import { describe, expect, it } from 'vitest';
import {ApiError,apiErrorBodySchema} from '../src/errors';

describe('API 错误契约', () => {

  it('错误对象只接受 code/message/requestId 三个字段', () => {
    const parsed = apiErrorBodySchema.safeParse({
      code: 'unauthorized',
      message: '需要有效的设备凭证。',
      requestId: 'req-1',
    });
    expect(parsed.success).toBe(true);
  });

  it('拒绝未知错误码，避免契约外字符串流入前端', () => {
    const parsed = apiErrorBodySchema.safeParse({
      code: 'totally_made_up',
      message: 'x',
      requestId: 'req-1',
    });
    expect(parsed.success).toBe(false);
  });

  it('要求 requestId 存在且非空，保证错误可被追踪', () => {
    expect(apiErrorBodySchema.safeParse({ code: 'not_found', message: 'x', requestId: '' }).success).toBe(false);
    expect(apiErrorBodySchema.safeParse({ code: 'not_found', message: 'x' }).success).toBe(false);
  });

  it('ApiError 的状态码由错误码唯一决定，不依赖调用方传参', () => {
    const error = new ApiError('payload_too_large', '请求体超过允许大小。', '内部诊断：actual=90000');
    expect(error.status).toBe(413);
    expect(error.code).toBe('payload_too_large');
    // logDetail 只供服务端日志，不属于对外契约字段。
    expect(Object.keys(JSON.parse(JSON.stringify(error)) as object)).not.toContain('logDetail');
  });

});
