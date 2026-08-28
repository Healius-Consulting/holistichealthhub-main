import { ArrowLeft, ChevronRight, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import AccessibilityPanel from '../accessibility/AccessibilityPanel';
import { openCommandPalette } from './commandPaletteEvents';

interface WorkspacePageHeaderProps {
  section: string;
  context: string;
  title: string;
  contextControl?: ReactNode;
  actions?: ReactNode;
  identity?: ReactNode;
  commandLabel?: string;
  onSectionClick?: () => void;
  backAction?: { label: string; onClick: () => void };
}

export default function WorkspacePageHeader({ section, context, title, contextControl, actions, identity, commandLabel = 'Quick find', onSectionClick, backAction }: WorkspacePageHeaderProps) {
  const toolbar = (
    <div className="app-header__actions">
      {actions}
      <button className="header-command-launcher" onClick={openCommandPalette} aria-label="Open command menu"><Search size={14} /><span>{commandLabel}</span><kbd>⌘K</kbd></button>
      {contextControl}
      <AccessibilityPanel />
    </div>
  );

  return (
    <header className="app-header workspace-page-header">
      <div className="brand-text">
        <div className="app-header__eyebrow">
          {backAction && <button type="button" className="workspace-back-button" onClick={backAction.onClick} aria-label={backAction.label}><ArrowLeft size={12} /> Back</button>}
          {backAction && <i aria-hidden="true" />}
          {onSectionClick ? <button type="button" className="workspace-breadcrumb-link" onClick={onSectionClick}>{section}</button> : <span>{section}</span>}
          <ChevronRight size={12} />{context}
        </div>
        <h1>{title}</h1>
      </div>
      {identity ? (
        <div className="workspace-page-header__toolbar">
          {toolbar}
          <div className="workspace-page-header__identity">{identity}</div>
        </div>
      ) : toolbar}
    </header>
  );
}
