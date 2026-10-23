/** 纯数据筛选、排序与分组投影；不依赖 Zod、网络或数据库。 */
import {normalizeNavText} from './nav-normalize';
import type {NavFilter,NavGroup,NavLink,NavLinkView,NavMembership,NavSortMode} from './nav-api';

// ---------------------------------------------------------------------------
// 筛选 / 排序 / 投影（唯一实现）
// ---------------------------------------------------------------------------

/** 关键词分词：规范化后按空白切分，全部命中才算匹配（AND）。 */
function textTokens(text: string | undefined): string[] {
  const normalized = normalizeNavText(text);
  return normalized.length === 0 ? [] : normalized.split(' ').filter((token) => token.length > 0);
}

function haystackOf(link: NavLink): string {
  return [
    normalizeNavText(link.title),
    normalizeNavText(link.description),
    link.tags.map((tag) => normalizeNavText(tag)).join(' '),
    link.aliases.map((alias) => normalizeNavText(alias)).join(' '),
  ].join('\n');
}

/**
 * 按筛选条件过滤链接（不含分组筛选：分组需要成员关系，见 `projectNavLinks`）。
 *
 * 规则：只考虑未删除链接；`status` 默认只看 `active`；`region` 命中该值或 `both`；
 * `tag` 按规范化值精确匹配；`favoritesOnly` 只看收藏。
 */
export function filterNavLinks(links: readonly NavLink[], filter: NavFilter): NavLink[] {
  const tokens = textTokens(filter.text);
  const status = filter.status ?? 'active';
  const tag = filter.tag === undefined ? null : normalizeNavText(filter.tag);
  return links.filter((link) => {
    if (link.deletedAt !== null) {
      return false;
    }
    if (link.status !== status) {
      return false;
    }
    if (filter.region !== undefined && link.region !== filter.region && link.region !== 'both') {
      return false;
    }
    if (filter.favoritesOnly === true && !link.isFavorite) {
      return false;
    }
    if (tag !== null && !link.tags.some((value) => normalizeNavText(value) === tag)) {
      return false;
    }
    if (tokens.length > 0) {
      const haystack = haystackOf(link);
      if (!tokens.every((token) => haystack.includes(token))) {
        return false;
      }
    }
    return true;
  });
}

/**
 * 排序（确定性）：同分时一律用 id 兜底打破平局，避免同一份数据在不同设备上顺序不同。
 * 返回新数组，绝不修改入参。
 */
export function sortNavLinks(links: readonly NavLink[], mode: NavSortMode): NavLink[] {
  const byId = (a: NavLink, b: NavLink): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byName = (a: NavLink, b: NavLink): number => {
    const left = normalizeNavText(a.title);
    const right = normalizeNavText(b.title);
    return left < right ? -1 : left > right ? 1 : byId(a, b);
  };
  const byManual = (a: NavLink, b: NavLink): number =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : byName(a, b);
  const sorted = [...links];
  switch (mode) {
    case 'title':
      sorted.sort(byName);
      break;
    case 'recent':
      sorted.sort((a, b) => (b.updatedAt !== a.updatedAt ? b.updatedAt - a.updatedAt : byId(a, b)));
      break;
    case 'favorite':
      sorted.sort((a, b) => (a.isFavorite === b.isFavorite ? byManual(a, b) : a.isFavorite ? -1 : 1));
      break;
    case 'manual':
      sorted.sort(byManual);
      break;
  }
  return sorted;
}

export interface ProjectNavLinksInput {
  readonly links: readonly NavLink[];
  readonly groups: readonly NavGroup[];
  readonly memberships: readonly NavMembership[];
  readonly filter?: NavFilter;
}

/**
 * 投影：把链接、分组、成员关系合成前端直接可渲染的视图。
 *
 * 只使用**未删除**的链接与成员关系，以及未删除的分组；因此「删掉的分组」不会作为幽灵分组
 * 出现在界面上。
 */
export function projectNavLinks(input: ProjectNavLinksInput): NavLinkView[] {
  const filter = input.filter ?? {};
  const groupById = new Map(
    input.groups.filter((group) => group.deletedAt === null).map((group) => [group.id, group] as const),
  );
  const groupIdsByLink = new Map<string, string[]>();
  for (const membership of input.memberships) {
    if (membership.deletedAt !== null || !groupById.has(membership.groupId)) {
      continue;
    }
    const list = groupIdsByLink.get(membership.linkId) ?? [];
    list.push(membership.groupId);
    groupIdsByLink.set(membership.linkId, list);
  }

  const candidates = filterNavLinks(input.links, filter).filter((link) => {
    if (filter.groupId === undefined) {
      return true;
    }
    return (groupIdsByLink.get(link.id) ?? []).includes(filter.groupId);
  });

  return sortNavLinks(candidates, filter.sort ?? 'manual').map((link) => {
    const groupIds = groupIdsByLink.get(link.id) ?? [];
    return {
      ...link,
      groupIds,
      groupNames: groupIds
        .map((groupId) => groupById.get(groupId)?.name ?? '')
        .filter((name) => name.length > 0),
    };
  });
}

