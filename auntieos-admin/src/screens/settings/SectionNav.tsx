import { type ReactNode } from 'react';
import { useRovingTabs } from '../../lib/useRovingTabs';

export interface SectionNavItem<Id extends string> {
  id: Id;
  label: string;
  /** The mock's 17px stroke glyph before the label. Decorative: the label is the name. */
  icon?: ReactNode;
}

interface SectionNavProps<Id extends string> {
  items: readonly SectionNavItem<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
}

/** Stable DOM id for a section's tab, so its panel can label itself with it. */
export function sectionTabId(id: string): string {
  return `settings-tab-${id}`;
}

/**
 * Stable DOM id for a section's panel, so its tab can point `aria-controls` at
 * it. Each section owns its own panel (visited panels stay mounted, hidden when
 * not active), so this is per-id rather than one shared panel.
 */
export function sectionPanelId(id: string): string {
  return `settings-panel-${id}`;
}

/**
 * The left, vertical section nav: a real WAI-ARIA `tablist`, the same
 * `useRovingTabs` keyboard contract every other tablist in this app uses
 * (`NotificationGate`, `Templates`, `Invoices`...), only oriented vertically so
 * Up/Down move between sections and one Tab keypress leaves the whole list.
 * Clicking (or Enter/Space on a focused tab) switches which single panel the
 * shell renders in the right column; this component owns none of that state, it
 * just reports the chosen id up through `onSelect`.
 *
 * Drawn as the mock's `.secnav` (issue #755): a glass panel of its own on the
 * navy ground, each row an icon and a label, the open one painted cream with
 * navy text. The surface and the row states live in `Settings.css`.
 */
export function SectionNav<Id extends string>({
  items,
  selected,
  onSelect,
}: SectionNavProps<Id>) {
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selected),
  );
  const { getTabProps } = useRovingTabs({
    count: items.length,
    activeIndex,
    orientation: 'vertical',
  });

  return (
    <div
      className="settings__nav"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Settings sections"
    >
      {items.map((item, index) => {
        const active = item.id === selected;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={sectionTabId(item.id)}
            aria-selected={active}
            aria-controls={sectionPanelId(item.id)}
            className={active ? 'settings__nav-item settings__nav-item--active' : 'settings__nav-item'}
            onClick={() => onSelect(item.id)}
            {...getTabProps(index)}
          >
            {item.icon}
            <span className="settings__nav-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
