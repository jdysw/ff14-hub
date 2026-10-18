/**
 * 工作台 API 客户端：幂等 `operationId` 的随机源契约（阶段 03 / HUB-045 · SonarCloud S2245）。
 *
 * 这里断言的是**安全事实**，不是实现细节：
 * `newOperationId()` 只允许使用安全随机源（`crypto.randomUUID()` 或 `crypto.getRandomValues()`）；
 * 两者都不可用时必须**显式抛错**，绝不退回 `Math.random()` / 时间戳这类弱随机数生成器。
 *
 * 为什么这不是「过度要求」：`operationId` 用于幂等去重（它不保密、不进凭证），
 * 但可预测的 ID 会让第三方猜到并复用别人的 ID，从而抑制或冒用真实的写入。
 */
import { operationIdSchema } from '@ff14-hub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newOperationId } from '../src/app/workbench/workbench-api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 只填充 16 字节的确定性替身：输出必须**全部**来自随机源。 */
function cryptoWithBytesOnly(byte: number): { getRandomValues: (array: Uint8Array) => Uint8Array } {
  return {
    getRandomValues: (array: Uint8Array): Uint8Array => {
      array.fill(byte);
      return array;
    },
  };
}

describe('newOperationId：只用安全随机源', () => {
  it('优先使用 crypto.randomUUID()，且结果满足共享契约', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555' });
    const id = newOperationId();
    expect(id).toBe('11111111-2222-4333-8444-555555555555');
    expect(operationIdSchema.safeParse(id).success).toBe(true);
  });

  it('没有 randomUUID 时用 crypto.getRandomValues() 生成十六进制（长度与字符集都合法）', () => {
    vi.stubGlobal('crypto', cryptoWithBytesOnly(0xab));
    const id = newOperationId();
    expect(id).toBe(`op-${'ab'.repeat(16)}`);
    expect(operationIdSchema.safeParse(id).success).toBe(true);
  });

  it('不使用 Math.random（弱随机数生成器）', () => {
    const randomSpy = vi.spyOn(Math, 'random');
    vi.stubGlobal('crypto', cryptoWithBytesOnly(0x01));
    newOperationId();
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it('没有安全随机源时显式抛错，而不是降级到弱随机', () => {
    vi.stubGlobal('crypto', {});
    expect(() => newOperationId()).toThrow(/没有可用的安全随机源/);
  });

  it('连 crypto 都没有时同样显式抛错', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => newOperationId()).toThrow(/没有可用的安全随机源/);
  });
});
