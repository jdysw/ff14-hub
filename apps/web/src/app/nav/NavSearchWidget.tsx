/**
 * `nav-search`：导航搜索与分类（阶段 04 / HUB-010 · 008 · 009）。
 *
 * 边界与 `nav-quick-links` 相同：只用 Host 注入的 `data: ModuleDataPort`，不自行 fetch；
 * 没有端口时调用 `reportAsyncError` 降级，绝不静默显示空列表。
 *
 * 搜索与排序**全部**走共享纯函数 `projectNavLinks`（内部 `filterNavLinks` + `sortNavLinks`）：
 * 关键词会命中标题 / 别名 / 描述 / 标签（规范化 NFKC + 小写 + 折叠空白），
 * 与服务端查询端点同一份规则，因此「组件里搜得到、服务端搜不到」的漂移不可能发生。
 *
 * 加载写在 effect 的**异步 IIFE** 里（与 `modules/use-module-state.ts` 同款）：
 * 状态写入发生在 `await` 之后，不会在 effect 体内同步 setState。
 */
import {
  navSearchConfigSchema,
  projectNavLinks,
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

/** 类型守卫：端口的 `unknown` → 快照（形状由端口用共享 Schema 校验过）。 */
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

export function NavSearchWidget(props: WidgetRuntimeProps) {
  const { config, data, retryToken, reportReady, reportEmpty, reportAsyncError } = props;
  const [snapshot, setSnapshot] = useState<NavSnapshot | null>(null);
  const [query, setQuery] = useState('');

  const parsedConfig = navSearchConfigSchema.safeParse(config);
  /** 依赖原始值而不是 `safeParse` 的返回对象（每次渲染都是新对象，会让 effect 无限重跑）。 */
  const configOk = parsedConfig.success;
  const configTitle = configOk ? parsedConfig.data.title : '导航搜索';
  const configGroupId = configOk ? parsedConfig.data.groupId : null;
  const configRegion = configOk ? parsedConfig.data.region : 'both';
  const configTag = configOk ? parsedConfig.data.tag : null;
  const configSort = configOk ? parsedConfig.data.sort : 'manual';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!configOk) {
        reportAsyncError(new Error('导航搜索组件配置不合法，未执行加载。'));
        return;
      }
      if (data === undefined) {
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
        const loaded = asSnapshot(raw);
        if (loaded === null) {
          reportAsyncError(new Error('导航快照形状不可用，未渲染任何结果。'));
          return;
        }
        setSnapshot(loaded);
        reportReady();
      } catch (error) {
        if (!cancelled) {
          reportAsyncError(error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configOk, data, reportAsyncError, reportReady, retryToken]);

  /**
   * 结果直接由共享纯函数在渲染期算出（本地搜索不额外发请求）。
   * 刻意**不**包 `useMemo`：这里的输入是「已加载的快照 + 搜索框文本」，
   * 计算量在个人规模（≤500 条）下可以忽略，而多一层记忆化只会增加失效面。
   */
  const results: readonly NavLinkView[] =
    snapshot === null
      ? []
      : projectNavLinks({
          links: snapshot.links,
          groups: snapshot.groups,
          memberships: snapshot.memberships,
          filter: {
            ...(query.trim().length === 0 ? {} : { text: query }),
            ...(configGroupId === null ? {} : { groupId: configGroupId }),
            /**
             * `both` 在配置里表示「不限区服」。
             *
             * 为什么不直接把它当筛选值传下去：共享过滤规则里 `region` 是**精确筛选**
             * （`link.region === 'both'` 才算命中），把「不限」传成 `'both'` 会把结果
             * 悄悄缩小成「只显示通用条目」——那与配置语义相反。
             */
            ...(configRegion === 'both' ? {} : { region: configRegion }),
            ...(configTag === null ? {} : { tag: configTag }),
            sort: configSort,
          },
        });

  /**
   * 空态上报：只在**已经拿到快照**且查询无结果时上报，避免把「还在加载」当成「没有内容」。
   * 依赖 `results.length` 这个数字（而不是数组本身）：数组每次渲染都是新引用。
   */
  const resultCount = results.length;
  useEffect(() => {
    if (snapshot === null || resultCount > 0) {
      return;
    }
    reportEmpty();
  }, [reportEmpty, resultCount, snapshot]);

  if (!configOk) {
    return <p className="panel__muted">组件配置不合法，未加载数据。</p>;
  }

  return (
    <div className="nav-widget" data-testid="nav-search">
      <h4 className="subsection-title">{configTitle}</h4>
      <label className="field">
        <span className="field__label">搜索标题 / 别名 / 描述 / 标签</span>
        <input
          type="search"
          className="field__input"
          data-testid="nav-search-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </label>
      {snapshot === null ? (
        <p className="panel__muted" role="status">
          正在加载导航数据…
        </p>
      ) : results.length === 0 ? (
        <p className="panel__muted" data-testid="nav-search-empty">
          没有匹配的链接（共 {snapshot.links.filter((link) => link.deletedAt === null).length} 条链接）。
        </p>
      ) : (
        <ul className="nav-widget__list" data-testid="nav-search-results">
          {results.map((link) => (
            <li className="nav-widget__item" key={link.id} data-testid="nav-search-result" data-link-id={link.id}>
              <span className="nav__icon" aria-hidden="true">
                {link.icon}
              </span>
              <a
                href={link.url}
                {...(link.openMode === 'new_tab'
                  ? { target: '_blank', rel: 'noreferrer noopener' }
                  : { rel: 'noreferrer noopener' })}
              >
                {link.title}
              </a>{' '}
              <span className="tag">{REGION_LABELS[link.region]}</span>
              {link.groupNames.length === 0 ? null : (
                <span className="tag tag--muted">{link.groupNames.join('、')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
