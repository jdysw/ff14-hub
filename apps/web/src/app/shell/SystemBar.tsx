/**
 * 玩家设置入口：先展示日常操作，高级调试功能按需展开。
 * 导航入口永远由 App Shell 提供，和业务组件的增删完全独立。
 */
import type { ShellView } from './shell-view';

interface SettingLink {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly view?: ShellView;
}

const PERSONAL_LINKS: readonly SettingLink[] = [
  { id: 'workbench', label: '自定义工作台', hint: '调整首页模块与布局', view: 'workbench' },
  { id: 'nav', label: '我的网站', hint: '整理常用工具和收藏', view: 'nav' },
  { id: 'fishing', label: '钓鱼手账', hint: '鱼窗与钓获进度', view: 'fishing' },
  { id: 'reminders', label: '提醒管理', hint: '调整提醒规则', view: 'reminders' },
];

const DATA_LINKS: readonly SettingLink[] = [
  { id: 'sync', label: '数据同步', hint: '同步鱼糕、管理数据', view: 'sync' },
  { id: 'backup', label: '导入 / 恢复', hint: '备份或恢复个人工作台', view: 'workbench' },
  { id: 'credentials', label: '会话凭证', hint: '连接个人空间；浏览公共内容无需连接', view: 'credentials' },
];

const ADVANCED_LINKS: readonly SettingLink[] = [
  { id: 'modules', label: '模块管理', hint: '启用、停用或恢复模块', view: 'modules' },
  { id: 'widgets', label: '组件验收', hint: '检查组件行为与运行状态', view: 'widgets' },
  { id: 'overview', label: '工作台概览', hint: '查看运行状态与健康检查', view: 'overview' },
  { id: 'devices', label: '设备管理', hint: '即将开放：设备列表与移除', },
];

function SettingGroup({ title, description, items, currentView, onSelectView }: {
  readonly title: string;
  readonly description: string;
  readonly items: readonly SettingLink[];
  readonly currentView: ShellView;
  readonly onSelectView: (view: ShellView) => void;
}) {
  return <section className="settings-group">
    <div className="settings-group__heading"><h3>{title}</h3><p>{description}</p></div>
    <ul className="system-bar__list">
      {items.map(item => <li key={item.id}>
        <button type="button" className={currentView === item.view ?
          'system-bar__item system-bar__item--active' : 'system-bar__item system-bar__item--enabled'}
          aria-current={item.view !== undefined && currentView === item.view ? 'page' : undefined}
          disabled={item.view === undefined}
          onClick={() => { if (item.view !== undefined) onSelectView(item.view); }}>
          <span className="system-bar__label">{item.label}</span>
          <span className="system-bar__hint">{item.hint}</span>
        </button>
      </li>)}
    </ul>
  </section>;
}

export interface SystemBarProps {
  readonly currentView: ShellView;
  readonly onSelectView: (view: ShellView) => void;
}

export function SystemBar({ currentView, onSelectView }: SystemBarProps) {
  return <nav className="system-bar" aria-label="系统级入口（不可移除）">
    <SettingGroup title="个性化" description="把常用内容放到顺手的位置"
      items={PERSONAL_LINKS} currentView={currentView} onSelectView={onSelectView}/>
    <SettingGroup title="数据与连接" description="只有使用个人同步功能时才需要连接"
      items={DATA_LINKS} currentView={currentView} onSelectView={onSelectView}/>
    <details className="settings-advanced" open={currentView !== 'settings' ? true : undefined}>
      <summary>高级设置 <span>模块维护与故障排查</span></summary>
      <SettingGroup title="高级工具" description="普通浏览无需使用以下功能"
        items={ADVANCED_LINKS} currentView={currentView} onSelectView={onSelectView}/>
    </details>
  </nav>;
}
