import { MoreHorizontal, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useModalFocus } from '../accessibility/useModalFocus';

export interface WorkspaceNavItem<Key extends string = string> {
  key: Key;
  label: string;
  shortLabel?: string;
  icon: ReactNode;
  count?: number;
}

export interface WorkspaceNavGroup<Key extends string = string> {
  label: string;
  items: WorkspaceNavItem<Key>[];
}

const COLLAPSE_STORAGE_KEY = 'hhh_workspace_sidebar_collapsed';

/** Reading storage can throw in private modes, so a failure just means expanded. */
function readCollapsedPreference() {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

interface WorkspaceNavigationProps<Key extends string> {
  ariaLabel: string;
  activeKey: Key;
  groups: WorkspaceNavGroup<Key>[];
  mobilePrimaryKeys: Key[];
  onNavigate: (key: Key) => void;
  brand: { title: string; subtitle: string; partner?: string; logoText?: string; logoSrc?: string; logo?: ReactNode };
  user: { initials: string; name: string; role: string };
  exitAction: { label: string; icon: ReactNode; onClick: () => void };
  footerAction?: { label: string; icon: ReactNode; onClick: () => void };
  moreTitle?: string;
}

export default function WorkspaceNavigation<Key extends string>({
  ariaLabel,
  activeKey,
  groups,
  mobilePrimaryKeys,
  onNavigate,
  brand,
  user,
  exitAction,
  footerAction,
  moreTitle = 'More workspace tools',
}: WorkspaceNavigationProps<Key>) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const mobileMenuRef = useModalFocus<HTMLElement>(mobileMenuOpen, () => setMobileMenuOpen(false));
  const items = groups.flatMap(group => group.items);
  const mobilePrimary = mobilePrimaryKeys.map(key => items.find(item => item.key === key)).filter((item): item is WorkspaceNavItem<Key> => Boolean(item));
  const mobileMore = items.filter(item => !mobilePrimaryKeys.includes(item.key));
  const mobileMoreActive = mobileMore.some(item => item.key === activeKey);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const closeDesktopSheet = (event: MediaQueryListEvent) => {
      if (!event.matches) setMobileMenuOpen(false);
    };
    media.addEventListener('change', closeDesktopSheet);
    return () => media.removeEventListener('change', closeDesktopSheet);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('has-collapsed-sidebar', collapsed);
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(collapsed));
    } catch {
      // A viewer preference is not worth failing the render over.
    }
    return () => document.body.classList.remove('has-collapsed-sidebar');
  }, [collapsed]);

  const navigate = (key: Key) => {
    onNavigate(key);
    setMobileMenuOpen(false);
  };

  const renderDesktopItem = (item: WorkspaceNavItem<Key>) => (
    <button
      type="button"
      key={item.key}
      className={`sidebar-item ${activeKey === item.key ? 'active' : ''}`}
      onClick={() => navigate(item.key)}
      aria-current={activeKey === item.key ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={item.label}
    >
      <span className="sidebar-item-content">{item.icon}<span>{item.label}</span></span>
      {item.count ? <span className="nav-queue-count" aria-label={`${item.count} items`}>{item.count}</span> : null}
    </button>
  );

  return (
    <>
      <aside className={`sidebar workspace-sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label={ariaLabel}>
        <div className="sidebar-header">
          <div className="sidebar-brand" title={brand.title}>
            {brand.logo
              ? <div className="workspace-sidebar-brand-mark">{brand.logo}</div>
              : brand.logoSrc
                ? <img className="workspace-sidebar-wordmark" src={brand.logoSrc} alt="" />
                : <div className="sidebar-logo" aria-hidden="true">{brand.logoText}</div>}
            <span className={brand.partner ? 'sidebar-brand-copy sidebar-brand-copy--cobrand' : 'sidebar-brand-copy'}>
              <strong>{brand.title}</strong>
              {brand.partner
                ? <><i className="sidebar-brand-joiner" aria-hidden="true">×</i><small>{brand.partner}</small></>
                : <small>{brand.subtitle}</small>}
            </span>
          </div>
          <button
            type="button"
            className="sidebar-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
          </button>
        </div>
        <nav className="sidebar-menu" aria-label={`${ariaLabel} navigation`}>
          {groups.map((group, index) => (
            <div className="workspace-nav-group" key={group.label}>
              {index > 0 ? <span className="sidebar-section-separator" aria-hidden="true" /> : null}
              <span className={`sidebar-menu-label${index ? ' sidebar-menu-label--spaced' : ''}`}>{group.label}</span>
              {group.items.map(renderDesktopItem)}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          {footerAction ? (
            <button type="button" className="btn btn-sm sidebar-footer-action" onClick={footerAction.onClick}>
              {footerAction.icon}<span>{footerAction.label}</span>
            </button>
          ) : null}
          <div className="user-profile-card">
            <div className="user-profile-avatar" aria-hidden="true">{user.initials}</div>
            <div className="user-profile-info"><span className="user-profile-name">{user.name}</span><span className="user-profile-role">{user.role}</span></div>
          </div>
          <button type="button" className="btn btn-sm sidebar-exit" title={exitAction.label} aria-label={exitAction.label} onClick={exitAction.onClick}>{exitAction.icon}<span>{exitAction.label}</span></button>
        </div>
      </aside>

      <nav className="mobile-bottom-nav" aria-label={`${ariaLabel} mobile navigation`}>
        {mobilePrimary.map(item => (
          <button type="button" key={item.key} className={activeKey === item.key ? 'active' : ''} aria-current={activeKey === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}>
            <span className="mobile-nav-icon">{item.icon}{item.count ? <i aria-label={`${item.count} items`}>{item.count}</i> : null}</span>
            <span>{item.shortLabel ?? item.label}</span>
          </button>
        ))}
        <button type="button" className={mobileMenuOpen || mobileMoreActive ? 'active' : ''} aria-expanded={mobileMenuOpen} aria-controls="mobile-more-menu" onClick={() => setMobileMenuOpen(open => !open)}>
          <span className="mobile-nav-icon"><MoreHorizontal size={19} /></span><span>More</span>
        </button>
      </nav>

      {mobileMenuOpen && (
        <div className="mobile-more-layer">
          <button type="button" className="mobile-more-backdrop" aria-label="Close more navigation" onClick={() => setMobileMenuOpen(false)} />
          <section id="mobile-more-menu" className="mobile-more-sheet" ref={mobileMenuRef} role="dialog" aria-modal="true" aria-labelledby="mobile-more-title" tabIndex={-1}>
            <header><span><small>{brand.title}</small><strong id="mobile-more-title">{moreTitle}</strong></span><button type="button" className="icon-button" aria-label="Close more navigation" onClick={() => setMobileMenuOpen(false)}><X size={17} /></button></header>
            <div className="mobile-more-grid">
              {mobileMore.map(item => <button type="button" key={item.key} className={activeKey === item.key ? 'active' : ''} aria-current={activeKey === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}><span>{item.icon}</span><strong>{item.label}</strong><small>{item.count ? `${item.count} waiting` : 'Open workspace'}</small></button>)}
            </div>
            <footer>
              {footerAction ? (
                <button type="button" className="btn btn-sm mobile-more-admins" onClick={() => { setMobileMenuOpen(false); footerAction.onClick(); }}>
                  {footerAction.icon}{footerAction.label}
                </button>
              ) : null}
              <div className="mobile-more-session">
                <span><strong>{user.name}</strong><small>{user.role}</small></span>
                <button type="button" className="btn btn-sm" onClick={() => { setMobileMenuOpen(false); exitAction.onClick(); }}>{exitAction.icon}{exitAction.label}</button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
