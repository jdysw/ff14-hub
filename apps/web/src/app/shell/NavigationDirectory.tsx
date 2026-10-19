/** 大量网址使用分类目录展示，数据仍来自现有导航控制器。 */
import { useId, useMemo, useState } from 'react';
import { validateNavUrl, type NavCatalogEntry, type NavLinkView, type NavRegion } from '@ff14-hub/shared';
import type { NavController } from '../nav/use-nav';
import type { ShellView } from './shell-view';

type DirectoryLink = NavCatalogEntry | NavLinkView;
interface DirectoryGroup {
  readonly key: string;
  readonly name: string;
  readonly links: DirectoryLink[];
}

/** 保留来源顺序；个人链接可在多个分组出现，未分组链接仍可找到。 */
export function groupDirectoryLinks(links: readonly DirectoryLink[], groupOrder: readonly { id: string; name: string }[]): DirectoryGroup[] {
  const groups = new Map<string, DirectoryGroup>();
  for (const group of groupOrder) groups.set(group.id, { key: group.id, name: group.name, links: [] });
  for (const link of links) {
    const memberships = 'category' in link
      ? [{ key: `catalog:${link.category}`, name: link.category.trim() || '未分类' }]
      : link.groupIds.length === 0
        ? [{ key: 'ungrouped', name: '未分组' }]
        : link.groupIds.map((id, index) => ({ key: id, name: link.groupNames[index] ?? '未命名分组' }));
    for (const membership of memberships) {
      let group = groups.get(membership.key);
      if (group === undefined) {
        group = { ...membership, links: [] };
        groups.set(membership.key, group);
      }
      group.links.push(link);
    }
  }
  return [...groups.values()].filter(group => group.links.length > 0);
}

export function NavigationDirectory({ nav, authenticated, onOpen }: {
  readonly nav: NavController;
  readonly authenticated: boolean;
  readonly onOpen: (view: ShellView) => void;
}) {
  const [showDescriptions, setShowDescriptions] = useState(false);
  const prefix = useId().replaceAll(':', '');
  const text = (nav.filter.text ?? '').trim().toLocaleLowerCase();
  const links = useMemo(() => authenticated ? nav.visibleLinks : (nav.catalog ?? []).filter(link =>
    !nav.filter.favoritesOnly && !nav.filter.groupId &&
    (nav.filter.region === undefined || link.region === nav.filter.region || link.region === 'both') &&
    [link.title, link.description, ...link.tags, ...link.aliases].join(' ').toLocaleLowerCase().includes(text)),
  [authenticated, nav.visibleLinks, nav.catalog, nav.filter, text]);
  const groups = useMemo(() => groupDirectoryLinks(links, authenticated ? nav.activeGroups : [])
    .filter(group => !nav.filter.groupId || group.key === nav.filter.groupId), [links, authenticated, nav.activeGroups, nav.filter.groupId]);
  const sectionId = (key: string): string => `${prefix}-category-${encodeURIComponent(key).replaceAll('%', '_')}`;
  const error = authenticated ? nav.error : nav.catalogError;
  const loading = (authenticated ? nav.snapshot === null : nav.catalog === null) && error === null;
  const clear = (): void => nav.patchFilter({ text: undefined, region: undefined, favoritesOnly: undefined, groupId: undefined });

  return <section id="home-navigation" className="home-navigation directory" aria-labelledby="home-navigation-title" data-testid="navigation-directory">
    <header className="home-section-heading">
      <div className="home-heading-group"><h2 id="home-navigation-title">导航站</h2><span className="home-section-kicker">{authenticated ? '我的导航' : '推荐目录'}</span></div>
      <button className="text-button" onClick={() => onOpen(authenticated ? 'nav' : 'credentials')}>{authenticated ? '管理导航' : '连接个人导航'} <span aria-hidden="true">↗</span></button>
    </header>
    <div className="directory-toolbar" aria-label="导航筛选">
      <div className="directory-toolbar__primary">
        <button className="home-filter" aria-pressed={!nav.filter.favoritesOnly && !nav.filter.groupId} onClick={() => nav.patchFilter({ favoritesOnly: undefined, groupId: undefined })}>全部</button>
        {authenticated ? <button className="home-filter" aria-pressed={nav.filter.favoritesOnly === true} onClick={() => nav.patchFilter({ favoritesOnly: nav.filter.favoritesOnly ? undefined : true })}>收藏</button> : null}
        <label className="directory-select"><span>区服</span><select aria-label="导航区服" value={nav.filter.region ?? ''} onChange={event => nav.patchFilter({ region: (event.target.value || undefined) as NavRegion | undefined })}><option value="">全部</option><option value="cn">国服</option><option value="global">国际服</option></select></label>
        {authenticated ? <label className="directory-select"><span className="visually-hidden">导航分组</span><select aria-label="导航分组" value={nav.filter.groupId ?? ''} onChange={event => nav.patchFilter({ groupId: event.target.value || undefined })}><option value="">所有分组</option>{nav.activeGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label> : null}
      </div>
      <label className="directory-description-toggle"><input type="checkbox" checked={showDescriptions} onChange={event => setShowDescriptions(event.target.checked)}/>显示简介</label>
      <span className="directory-count" role="status" aria-live="polite">{links.length} 个站点 · {groups.length} 个分类</span>
    </div>
    {error !== null ? <p className="notice notice--error" role="alert">{error} <button className="text-button" onClick={() => { void (authenticated ? nav.reload() : nav.loadCatalog()); }}>重试</button></p> : null}
    {loading ? <p className="home-state" role="status">正在读取导航目录…</p> : links.length === 0 ?
      <div className="home-nav-empty"><p>{text ? `没有找到与「${nav.filter.text ?? ''}」匹配的站点。` : '当前筛选下没有站点。'}</p><button className="text-button" onClick={clear}>清空筛选</button></div> : <>
        <div className="directory-jumpbar">
          <span className="directory-jumpbar__label">分类定位</span>
          <nav className="directory-index" aria-label="网站分类索引">{groups.map(group => <a key={group.key} href={`#${sectionId(group.key)}`}>{group.name}<span>{group.links.length}</span></a>)}</nav>
          <label className="directory-mobile-jump"><span className="visually-hidden">跳转到网站分类</span><select aria-label="跳转到网站分类" value="" onChange={event => {
            const target = document.getElementById(event.target.value);
            target?.scrollIntoView({ block: 'start', behavior: 'auto' });
            target?.focus({ preventScroll: true });
          }}><option value="" disabled>选择分类快速定位</option>{groups.map(group => <option key={group.key} value={sectionId(group.key)}>{group.name}（{group.links.length}）</option>)}</select></label>
          <a className="directory-back" href="#home-navigation">目录顶部 ↑</a>
        </div>
        <div className={`directory-sections${showDescriptions ? ' directory-sections--descriptions' : ''}`}>
          {groups.map(group => <section className="directory-category" key={group.key} aria-labelledby={sectionId(group.key)}>
            <h3 id={sectionId(group.key)} tabIndex={-1}>{group.name}<span>{group.links.length}</span></h3>
            <ul className="directory-links">{group.links.map(link => <li key={link.id}>
              {validateNavUrl(link.url).ok ? <a href={link.url} {...(link.openMode === 'same_tab' ? {} : { target: '_blank' })} rel="noopener noreferrer" title={link.description || link.title}>
                <span className="directory-link-title">{link.title}</span>
                {showDescriptions && link.description ? <span className="directory-link-description">{link.description}</span> : null}
              </a> : <span className="directory-invalid">{link.title}（地址不可用）</span>}
            </li>)}</ul>
          </section>)}
        </div>
      </>}
  </section>;
}
