/**
 * 演示组件（**无任何游戏业务语义**）。
 *
 * 命名与文案都显式标注「演示」，不得被误认为真实鱼类 / 活动 / 导航数据。
 * 它们存在的唯一目的，是让 HUB-044 的验收点可以被真实观察：
 * 多实例配置互不串扰、加载态、空态、渲染错误、异步错误、重试、错误隔离。
 */
import {
  DEMO_FAULT_MODES,
  type DemoCounterConfig,
  type DemoFaultConfig,
  type DemoSoloConfig,
} from '@ff14-hub/shared';
import { useEffect, useState } from 'react';
import type { WidgetRuntimeProps } from './types';

const DEMO_BADGE = '演示组件 · 无游戏业务数据';

/**
 * `demo-counter`：可多实例。每个实例有独立的步长与标签，
 * 计数状态完全落在组件自身，因此两个实例互不影响。
 */
export function DemoCounterWidget(props: WidgetRuntimeProps) {
  const config = props.config as DemoCounterConfig;
  // 「是否就绪」用「报告就绪时的令牌」表示，而不是在 effect 里同步 setState：
  // 后者会造成级联渲染（react-hooks/set-state-in-effect），也会让重试语义变模糊。
  const [readyToken, setReadyToken] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const { reportReady, retryToken } = props;
  const ready = readyToken === retryToken;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) {
        return;
      }
      setReadyToken(retryToken);
      reportReady();
    }, config.initDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [config.initDelayMs, retryToken, reportReady]);

  if (!ready) {
    // 刻意不在这里渲染加载骨架：加载态由 Host 拥有，组件只负责「什么时候算就绪」。
    return <p className="demo-widget__note">正在准备演示数据…</p>;
  }

  return (
    <div className="demo-widget">
      <p className="demo-widget__badge">{DEMO_BADGE}</p>
      <p className="demo-widget__label">{config.label}</p>
      <div className="demo-widget__row">
        <button type="button" className="button button--small" onClick={() => setCount((value) => value - config.step)}>
          −{config.step}
        </button>
        <output className="demo-widget__count" aria-live="polite">
          {count}
        </output>
        <button type="button" className="button button--small" onClick={() => setCount((value) => value + config.step)}>
          +{config.step}
        </button>
      </div>
      <p className="demo-widget__note">
        本实例步长 {config.step}。两个同类型实例的计数与配置互不串扰。
      </p>
    </div>
  );
}

/**
 * `demo-fault`：**故意**制造空态 / 渲染错误 / 异步错误的演示组件。
 * 它证明「一个组件坏掉不会击穿兄弟组件与 Shell」，以及异步错误确实被单独处理。
 */
export function DemoFaultWidget(props: WidgetRuntimeProps) {
  const config = props.config as DemoFaultConfig;
  const { reportReady, reportEmpty, reportAsyncError, retryToken } = props;

  useEffect(() => {
    if (config.mode !== 'async-error') {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        reportAsyncError(new Error('演示：异步加载失败（模拟网络错误）'));
      }
    }, config.delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [config.mode, config.delayMs, retryToken, reportAsyncError]);

  useEffect(() => {
    if (config.mode === 'empty') {
      reportEmpty();
      return;
    }
    if (config.mode !== 'render-error') {
      reportReady();
    }
  }, [config.mode, retryToken, reportReady, reportEmpty]);

  if (config.mode === 'render-error') {
    // 渲染期抛错：必须由 React 错误边界捕获，Host 才能把错误隔离开。
    throw new Error('演示：渲染期错误（模拟组件自身缺陷）');
  }

  return (
    <div className="demo-widget">
      <p className="demo-widget__badge">{DEMO_BADGE}</p>
      <p className="demo-widget__note">
        当前失效模式：<code>{config.mode}</code>
      </p>
      <ul className="demo-widget__hints">
        {DEMO_FAULT_MODES.map((mode) => (
          <li key={mode}>
            <code>{mode}</code>
            {mode === config.mode ? '（当前）' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `demo-solo`：`allowMultiple=false`，用来验证单例策略。 */
export function DemoSoloWidget(props: WidgetRuntimeProps) {
  const config = props.config as DemoSoloConfig;
  const { reportReady, retryToken } = props;

  useEffect(() => {
    reportReady();
  }, [reportReady, retryToken]);

  return (
    <div className="demo-widget">
      <p className="demo-widget__badge">{DEMO_BADGE}</p>
      <p className="demo-widget__label">{config.title}</p>
      <p className="demo-widget__note">该组件类型声明 allowMultiple=false，最多只能有一个实例。</p>
    </div>
  );
}
