/**
 * 模板选择（阶段 03 / HUB-049）。
 *
 * 硬要求：`honestyNote` 必须**原样**渲染（不是改写、不是省略）。
 * 它如实说明「真实的导航 / 钓鱼 / 高难模块在阶段 04–05 才提供，
 * 现在这些只是已注册的演示组件，不是游戏数据」。
 *
 * 交互：先选中一个模板（`template-option`），再显式确认（`template-confirm`）才提交；
 * `mode` 也由用户选择，因为「新建页面 / 替换当前页面内容 / 重置整个工作台」影响范围完全不同。
 * `reset_workspace` 与 `replace_page` 属于破坏性操作，按钮文案里直接写清影响范围。
 */
import { useEffect, useState } from 'react';
import type { WorkbenchTemplateId } from '@ff14-hub/shared';
import type { TemplateSummary } from './workbench-api';
import type { WorkbenchController } from './use-workbench';

export interface TemplatePickerProps {
  readonly state: WorkbenchController;
}

type ApplyMode = 'new_page' | 'replace_page' | 'reset_workspace';

const MODE_LABELS: Readonly<Record<ApplyMode, string>> = {
  new_page: '新建页面',
  replace_page: '替换当前页面',
  reset_workspace: '重置整个工作台',
};

/**
 * 「当前选择」那一行说明：用提前返回把「还没选」与「已选」分开，
 * 而不是叠成嵌套三元（S3358）。
 */
function selectionSummary(selected: TemplateSummary | null, mode: ApplyMode): string {
  if (selected === null) {
    return '尚未选择模板：请先在上面选择，再点「确认应用模板」。';
  }
  return `已选择「${selected.displayName}」，应用方式：${MODE_LABELS[mode]}。点击确认后才会提交。`;
}

/**
 * 确认按钮的 title：三种「为什么不能点 / 点了会做什么」依次提前返回（S3358）。
 */
function confirmHint(selected: TemplateSummary | null, mode: ApplyMode, hasActivePage: boolean): string {
  if (selected === null) {
    return '请先选择模板';
  }
  if (mode === 'replace_page' && !hasActivePage) {
    return '当前没有页面可替换';
  }
  return '应用所选模板';
}

export function TemplatePicker(props: TemplatePickerProps) {
  const { state } = props;
  const [selected, setSelected] = useState<WorkbenchTemplateId | null>(null);
  const [mode, setMode] = useState<ApplyMode>('new_page');
  const [pageName, setPageName] = useState('');
  // 解构出稳定的值与稳定的回调，避免 effect 依赖一个每渲染都新建的对象。
  const loadedTemplates = state.templates;
  const loadTemplates = state.loadTemplates;

  useEffect(() => {
    if (loadedTemplates === null) {
      void loadTemplates();
    }
  }, [loadedTemplates, loadTemplates]);

  const templates = state.templates ?? [];
  const selectedTemplate = templates.find((template) => template.id === selected) ?? null;

  return (
    <section className="workbench__panel" aria-labelledby="workbench-templates-title" id="workbench-templates">
      <h3 className="subsection-title" id="workbench-templates-title">
        模板（可自由修改的起点）
      </h3>
      <p className="panel__muted">
        模板不是永久绑定关系，应用之后可以随意增删组件与调整布局。
        下面每个模板都附带<strong>诚实说明</strong>，请不要把演示组件当成真实游戏数据。
      </p>

      <ul className="workbench__list" data-testid="template-picker">
        {templates.map((template) => {
          const active = template.id === selected;
          return (
            <li key={template.id} className="workbench__list-item workbench__list-item--stacked">
              <div className="workbench__list-main">
                <p className="workbench__list-title">
                  {template.displayName}
                  {template.recommendedDefault ? <span className="tag tag--status">推荐默认</span> : null}
                  {template.isEmpty ? <span className="tag tag--muted">空模板</span> : null}
                  {template.isDemoOnly ? <span className="tag tag--warn">仅演示组件</span> : null}
                </p>
                <p className="workbench__list-meta">
                  <code>{template.id}</code> · 页面：{template.pageNames.join('、') || '（无）'} ·
                  组件数：{template.widgetCount}
                </p>
                <p className="workbench__list-meta">{template.description}</p>
                {/* 诚实说明必须原样展示：这是契约里 `honestyNote` 的逐字内容。 */}
                <p className="workbench__honesty" data-testid="template-honesty-note">
                  {template.honestyNote}
                </p>
              </div>
              <button
                type="button"
                className={active ? 'button button--small button--active' : 'button button--small'}
                data-testid="template-option"
                data-template-id={template.id}
                aria-pressed={active}
                aria-label={`选择模板：${template.displayName}`}
                onClick={() => {
                  setSelected(template.id);
                  setPageName(template.pageNames[0] ?? '');
                }}
              >
                {active ? '已选择' : '选择'}
              </button>
            </li>
          );
        })}
        {templates.length === 0 ? <li className="panel__muted">正在加载模板目录…</li> : null}
      </ul>

      <fieldset className="workbench__fieldset">
        <legend className="field__label">应用方式（影响范围不同，请确认）</legend>
        {(
          [
            { value: 'new_page', label: '新建页面（不动现有页面）' },
            { value: 'replace_page', label: '替换当前页面内容（现有组件会被移除）' },
            { value: 'reset_workspace', label: '重置整个工作台（墓碑化全部页面，可逐页恢复）' },
          ] as const
        ).map((option) => (
          <label key={option.value} className="field field--inline">
            <input
              type="radio"
              name="workbench-template-mode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => {
                setMode(option.value);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      {mode === 'new_page' ? (
        <label className="field">
          <span className="field__label">新页面名称（留空则使用模板首页名）</span>
          <input
            className="field__input"
            data-testid="template-page-name"
            value={pageName}
            maxLength={60}
            onChange={(event) => {
              setPageName(event.target.value);
            }}
          />
        </label>
      ) : null}

      <p className="workbench__status" data-testid="template-selection">
        {selectionSummary(selectedTemplate, mode)}
      </p>

      <div className="workbench__toolbar-group">
        <button
          type="button"
          className="button"
          data-testid="template-confirm"
          disabled={selectedTemplate === null || state.busy || (mode === 'replace_page' && state.activePageId === null)}
          title={confirmHint(selectedTemplate, mode, state.activePageId !== null)}
          onClick={() => {
            if (selectedTemplate === null) {
              return;
            }
            const trimmed = pageName.trim();
            void state.applyTemplate({
              templateId: selectedTemplate.id,
              mode,
              ...(mode === 'new_page' && trimmed.length > 0 ? { pageName: trimmed } : {}),
            });
          }}
        >
          确认应用模板
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="template-cancel"
          onClick={() => {
            setSelected(null);
            setMode('new_page');
            setPageName('');
            state.setNotice('已取消模板选择，未做任何改动。');
          }}
        >
          取消选择
        </button>
      </div>
    </section>
  );
}
