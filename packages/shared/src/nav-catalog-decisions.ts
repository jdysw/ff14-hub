/** 系统导航目录升级/显式再次导入的纯判定，无副作用。 */
import {normalizeNavText} from './nav-normalize';
import type {NavCatalogEntry,NavCatalogEntryState,NavLink} from './nav-api';

// ---------------------------------------------------------------------------
// 目录升级判定（D1：升级 ≠ 再导入）
// ---------------------------------------------------------------------------

/**
 * 判定「用户是否改过这条副本」时**只**比较可编辑内容字段（下面逐个列出）；
 * 分组归属不算——它属于个人组织方式，不是对目录内容的修改。
 */
function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => normalizeNavText(value) === normalizeNavText(right[index] ?? ''));
}

export function navCatalogEntryState(input: {
  readonly entry: NavCatalogEntry;
  readonly link: NavLink | undefined;
}): NavCatalogEntryState {
  const { entry, link } = input;
  if (link === undefined) {
    return 'new';
  }
  if (link.deletedAt !== null) {
    // 墓碑优先于一切：用户删掉了它，目录升级不能把它变成"已修改"或"未变化"。
    return 'tombstoned';
  }
  const modified =
    link.title !== entry.title ||
    link.url !== entry.url ||
    link.description !== entry.description ||
    link.openMode !== entry.openMode ||
    link.region !== entry.region ||
    link.isFavorite ||
    link.icon !== entry.icon ||
    !sameStringList(link.tags, entry.tags) ||
    !sameStringList(link.aliases, entry.aliases);
  return modified ? 'user_modified' : 'unchanged';
}

export interface CatalogUpgradePlanEntry {
  readonly state: NavCatalogEntryState;
  readonly catalogId: string;
  readonly linkId: string | null;
}

/** 目录 → 个人副本的升级计划（只读报告，不写任何数据）。排序稳定：按目录 ID。 */
export function catalogUpgradePlan(input: {
  readonly catalog: readonly NavCatalogEntry[];
  readonly links: readonly NavLink[];
}): CatalogUpgradePlanEntry[] {
  const byCatalogId = new Map<string, NavLink>();
  for (const link of input.links) {
    if (link.sourceCatalogId !== null && !byCatalogId.has(link.sourceCatalogId)) {
      byCatalogId.set(link.sourceCatalogId, link);
    }
  }
  return [...input.catalog]
    .sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    })
    .map((entry) => {
      const link = byCatalogId.get(entry.id);
      return {
        state: navCatalogEntryState({ entry, link }),
        catalogId: entry.id,
        linkId: link?.id ?? null,
      };
    });
}

export interface NavCatalogImportDecision {
  readonly action: 'insert' | 'update' | 'restore_tombstone' | 'skip';
  readonly reason: string;
}

/**
 * 单条目录条目的导入决策。
 *
 * 四条规则（缺一不可）：
 * - 墓碑 + 非显式再导入 → `skip`：**目录升级绝不复活用户删掉的条目**；
 * - 墓碑 + 显式再导入 → `restore_tombstone`：这是唯一复活入口，且必须是用户点出来的；
 * - 用户改过 + 未显式允许覆盖 → `skip`：**目录升级不覆盖个人修改**；
 * - 未变化 → `skip`；不存在 → `insert`；存在且改动未被用户改过且允许覆盖 → `update`。
 */
export function decideCatalogImport(input: {
  readonly state: NavCatalogEntryState;
  readonly explicitReimport?: boolean;
  readonly overwriteUserEdits?: boolean;
}): NavCatalogImportDecision {
  const explicit = input.explicitReimport === true;
  const overwrite = input.overwriteUserEdits === true;
  switch (input.state) {
    case 'new':
      return { action: 'insert', reason: '目录条目尚未导入' };
    case 'tombstoned':
      return explicit
        ? { action: 'restore_tombstone', reason: '用户显式再次导入：恢复该条目的墓碑行' }
        : { action: 'skip', reason: '该条目已被用户删除；只有显式再次导入才会恢复' };
    case 'user_modified':
      return explicit && overwrite
        ? { action: 'update', reason: '用户显式再次导入并确认覆盖个人修改' }
        : { action: 'skip', reason: '该条目已被用户修改；目录升级不覆盖个人修改' };
    case 'unchanged':
      return explicit && overwrite
        ? { action: 'update', reason: '用户显式再次导入并确认以目录内容刷新' }
        : { action: 'skip', reason: '与目录内容一致，无需变更' };
  }
}

