/**
 * 系统级入口栏。
 *
 * 硬约束（INV-02 / 规划 4.3）：系统设置、工作台切换、组件库、导入/恢复、设备管理
 * 必须永久位于 App Shell，**不能被用户删除或隐藏**。
 * 因此这里的条目是壳层的一部分，而不是可由页面配置的 Widget 实例。
 *
 * 阶段 02 的状态：模块管理与组件验收（含会话凭证）已经接入真实视图并可点击；
 * 其余条目仍然 disabled，作为后续阶段的**可见**占位（而不是靠文档口头说明）。
 */
import type { ShellView } from './shell-view';

interface SystemEntry {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** 该能力计划落地的阶段/任务，便于对照规划而不是靠记忆。 */
  readonly stage: string;
  /** 已接入的视图。没有该字段即表示尚未接入，按钮保持不可用。 */
  readonly view?: ShellView;
}

/**
 * 系统级入口（顺序有意义）：
 * 「自定义工作台」**排第一**，因为端到端测试用
 * `getByRole('navigation', {name:'系统级入口（不可移除）'}).getByRole('button', {name:/工作台/}).first()`
 * 打开工作台——「工作台概览」也匹配 /工作台/，所以主入口必须排在它前面。
 */
const SYSTEM_ENTRIES: readonly SystemEntry[] = [
  {id:'fishing',label:'钓鱼手账',hint:'天气窗口与独立进度',stage:'阶段 05A',view:'fishing'},
  {id:'reminders',label:'提醒管理',hint:'规则、设备与投递记录',stage:'阶段 05B',view:'reminders'},
  {id:'sync',label:'数据同步',hint:'鱼糕文件与导入恢复',stage:'阶段 06A',view:'sync'},
  {
    id: 'workbench',
    label: '自定义工作台',
    hint: '多页面、拖拽布局、模板与备份恢复',
    stage: '阶段 03 / HUB-045 · 046 · 049 · 054',
    view: 'workbench',
  },
  {
    id: 'overview',
    label: '工作台概览',
    hint: '阶段说明与 API 连通性',
    stage: '当前可用',
    view: 'overview',
  },
  {
    id: 'widget-library',
    label: '组件验收',
    hint: '添加 Widget 实例（演示组件）',
    stage: '阶段 02 / HUB-044',
    view: 'widgets',
  },
  {
    id: 'modules',
    label: '模块管理',
    hint: '启用、停用、逻辑卸载、恢复',
    stage: '阶段 02 / HUB-050',
    view: 'modules',
  },
  {
    id: 'credentials',
    label: '会话凭证',
    hint: '仅本次会话内存，刷新即失效',
    stage: '阶段 02 / HUB-050',
    view: 'credentials',
  },
  { id: 'settings', label: '系统设置', hint: '区服、时区、主题', stage: '阶段 03' },
  {
    id: 'backup',
    label: '导入 / 恢复',
    hint: '配置备份与恢复默认（就位于工作台视图内）',
    stage: '阶段 03 / HUB-054',
    view: 'workbench',
  },
  { id: 'devices', label: '设备管理', hint: '设备列表与撤销', stage: '后端 API 已就绪 · 界面后续' },
];

export interface SystemBarProps {
  readonly currentView: ShellView;
  readonly onSelectView: (view: ShellView) => void;
}

export function SystemBar(props: SystemBarProps) {
  return (
    <nav className="system-bar" aria-label="系统级入口（不可移除）">
      <p className="system-bar__note">
        以下入口属于 App Shell，永久保留，用户清空全部业务组件后仍可进入。
        标注为后续阶段的条目尚未接入，按钮保持不可用。
      </p>
      <ul className="system-bar__list">
        {SYSTEM_ENTRIES.map((entry) => {
          const view = entry.view;
          const active = view !== undefined && view === props.currentView;
          return (
            <li key={entry.id}>
              <button
                type="button"
                className={
                  active ? 'system-bar__item system-bar__item--active' : 'system-bar__item system-bar__item--enabled'
                }
                disabled={view === undefined}
                aria-disabled={view === undefined}
                aria-current={active ? 'page' : undefined}
                onClick={
                  view === undefined
                    ? undefined
                    : () => {
                        props.onSelectView(view);
                      }
                }
              >
                <span className="system-bar__label">{entry.label}</span>
                <span className="system-bar__hint">{entry.hint}</span>
                <span className="system-bar__stage">{entry.stage}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
