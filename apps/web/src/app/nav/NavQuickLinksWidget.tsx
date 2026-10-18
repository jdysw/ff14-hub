/**
 * `nav-quick-links`：常用 / 收藏网站（阶段 04 / HUB-010 · 008 · 009）。
 *
 * 边界（与 `WidgetRuntimeProps.data` 的契约一致，不允许绕过）：
 * - 组件**不**自己 `fetch`、**不**读库、**不**拿 Token：数据只来自 Host 注入的
 *   `data: ModuleDataPort`，且只能调用本模块声明过的操作名。
 * - 没有端口时**降级**：调用 `reportAsyncError` 给出可解释的原因，Host 会渲染错误卡片
 *   而不是让这张卡片空白或抛错。
 * - 筛选/排序调用共享纯函数 `projectNavLinks`（内部 `filterNavLinks` + `sortNavLinks`），
 *   与导航视图、服务端查询端点共用同一份实现。
 *
 * 加载写在 effect 的**异步 IIFE** 里（与 `modules/use-module-state.ts` 同款）：
 * 状态写入发生在 `await` 之后，因此不会在 effect 体内同步 setState 引发级联渲染；
 * 卸载时用 `cancelled` 丢掉迟到的响应，`retryToken` 变化则重新执行整段加载。
 */
import {
  navQuickLinksConfigSchema,
  projectNavLinks,
  NAV_DEFAULT_ICON,
  type NavLinkView,
  type NavRegion,
  type NavSnapshot,
} from '@ff14-hub/shared';
import { useEffect, useState } from 'react';
import type { WidgetRuntimeProps } from '../widgets/types';

/** 本组件只读快照操作（与 `nav-data-port.ts` 的操作名一致）。 */
const SNAPSHOT_OPERATION = 'nav.snapshot';

const REGION_LABELS: Readonly<Record<NavRegion, string>> = {
  cn: '国服',
  global: '国际服',
  both: '通用',
};

/** 从 URL 取主机名（只用于显示，不把 URL 交给任何解析器去「规范化」）。 */
function hostOf(url: string): string {
  const withoutScheme = url.startsWith('https://') ? url.slice('https://'.length) : url;
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
  return authority.length === 0 ? url : authority;
}

/** 类型守卫：把端口的 `unknown` 收窄成快照；形状已由端口用共享 Schema 校验过。 */
function asSnapshot(value: unknown): NavSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Partial<NavSnapshot>;
  if (!Array.isArray(candidate.links) || !Array.isArray(candidate.groups) || !Array.isArray(candidate.memberships)) {
    return null;
  }
  return candidate as NavSnapshot;
}

export function NavQuickLinksWidget(props: WidgetRuntimeProps) {
  const { config, data, retryToken, reportReady, reportEmpty, reportAsyncError } = props;
  const [links, setLinks] = useState<readonly NavLinkView[]>([]);
  const [totalActive, setTotalActive] = useState(0);

  const parsedConfig = navQuickLinksConfigSchema.safeParse(config);
  /**
   * 依赖**原始值**而不是 `parsedConfig` 对象：Zod 每次 `safeParse` 都返回新对象，
   * 若把它放进依赖数组，effect 每次渲染都会重跑。
   */
  const configOk = parsedConfig.success;
  const configTitle = configOk ? parsedConfig.data.title : '';
  const configGroupId = configOk ? parsedConfig.data.groupId : null;
  const configFavoritesOnly = configOk ? parsedConfig.data.favoritesOnly : false;
  const configLimit = configOk ? parsedConfig.data.limit : 0;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!configOk) {
        reportAsyncError(new Error('导航组件配置不合法，未执行加载。'));
        return;
      }
      if (data === undefined) {
        // 没有数据端口 = 宿主没有接线：明确说明，而不是静默显示空列表。
        reportAsyncError(
          new Error('该组件需要模块数据端口（Host 未提供），无法读取导航数据；组件不会自行发起请求。'),
        );
        return;
      }
      try {
        const raw = await data.call(SNAPSHOT_OPERATION);
        if (cancelled) {
          return;
        }
        const snapshot = asSnapshot(raw);
        if (snapshot === null) {
          reportAsyncError(new Error('导航快照形状不可用，未渲染任何条目。'));
          return;
        }
        const visible = projectNavLinks({
          links: snapshot.links,
          groups: snapshot.groups,
          memberships: snapshot.memberships,
          filter: {
            // 收藏优先排序：quick-links 的语义是「最常用的排前面」，
            // 而收藏是唯一由用户显式表达「常用」的信号（排序规则由共享纯函数负责）。
            sort: 'favorite',
            ...(configGroupId === null ? {} : { groupId: configGroupId }),
            ...(configFavoritesOnly ? { favoritesOnly: true } : {}),
          },
        });
        if (cancelled) {
          return;
        }
        setTotalActive(snapshot.links.filter((link) => link.deletedAt === null).length);
        setLinks(visible.slice(0, configLimit));
        if (visible.length === 0) {
          reportEmpty();
          return;
        }
        reportReady();
      } catch (error) {
        // 端口抛出的错误（含 409 / 能力不足 / 门禁拒绝）必须走 reportAsyncError：
        // 错误边界捕获不到异步失败。
        if (!cancelled) {
          reportAsyncError(error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    configFavoritesOnly,
    configGroupId,
    configLimit,
    configOk,
    data,
    reportAsyncError,
    reportEmpty,
    reportReady,
    // retryToken 必须在依赖里：否则 Host 的「重试」不会重新执行加载。
    retryToken,
  ]);

  if (!configOk) {
    return <p className="panel__muted">组件配置不合法，未加载数据。</p>;
  }

  return (
    <div className="nav-widget" data-testid="nav-quick-links">
      <h4 className="subsection-title">{configTitle}</h4>
      {links.length === 0 ? (
        <p className="panel__muted">
          当前没有可显示的常用链接（共 {totalActive} 条链接）。
          {configFavoritesOnly ? '这里只显示收藏的链接。' : ''}
        </p>
      ) : (
        <ul className="nav-widget__list" data-testid="nav-quick-links-list">
          {links.map((link) => (
            <li className="nav-widget__item" key={link.id} data-testid="nav-quick-link" data-link-id={link.id}>
              {/* 图标是**纯文本**：直接渲染，绝不使用 dangerouslySetInnerHTML。 */}
              <span className="nav__icon" aria-hidden="true">
                {link.icon.length === 0 ? NAV_DEFAULT_ICON : link.icon}
              </span>
              <a
                href={link.url}
                {...(link.openMode === 'new_tab'
                  ? { target: '_blank', rel: 'noreferrer noopener' }
                  : { rel: 'noreferrer noopener' })}
                data-testid="nav-quick-link-anchor"
              >
                {link.title}
              </a>{' '}
              <code className="nav-widget__host">{hostOf(link.url)}</code>{' '}
              <span className="tag">{REGION_LABELS[link.region]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
