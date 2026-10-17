/**
 * 系统级入口栏。
 *
 * 硬约束（INV-02 / 规划 4.3）：系统设置、工作台切换、组件库、导入/恢复、设备管理
 * 必须永久位于 App Shell，**不能被用户删除或隐藏**。
 * 因此这里的条目是壳层的一部分，而不是可由页面配置的 Widget 实例。
 *
 * 阶段 01 只渲染结构与说明，所有条目均不可用（disabled），
 * 后续阶段逐个接入真实能力；这样做的目的是先把「不可移除的系统入口」这一不变量固化到结构里。
 */

interface SystemEntry {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** 该能力计划落地的阶段/任务，便于对照规划而不是靠记忆。 */
  readonly stage: string;
}

const SYSTEM_ENTRIES: readonly SystemEntry[] = [
  { id: 'workspace-switch', label: '工作台切换', hint: '多页面与默认页', stage: '阶段 03 / HUB-046' },
  { id: 'widget-library', label: '组件库', hint: '添加 Widget 实例', stage: '阶段 02 / HUB-044' },
  { id: 'modules', label: '模块管理', hint: '启用、停用、逻辑卸载', stage: '阶段 02 / HUB-050' },
  { id: 'settings', label: '系统设置', hint: '区服、时区、主题', stage: '阶段 03' },
  { id: 'backup', label: '导入 / 恢复', hint: '配置备份与恢复默认', stage: '阶段 03 / HUB-054' },
  { id: 'devices', label: '设备管理', hint: '设备列表与撤销', stage: '阶段 01 / HUB-006' },
];

export function SystemBar() {
  return (
    <nav className="system-bar" aria-label="系统级入口（不可移除）">
      <p className="system-bar__note">
        以下入口属于 App Shell，永久保留，用户清空全部业务组件后仍可进入。
      </p>
      <ul className="system-bar__list">
        {SYSTEM_ENTRIES.map((entry) => (
          <li key={entry.id}>
            <button type="button" className="system-bar__item" disabled aria-disabled="true">
              <span className="system-bar__label">{entry.label}</span>
              <span className="system-bar__hint">{entry.hint}</span>
              <span className="system-bar__stage">{entry.stage}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
