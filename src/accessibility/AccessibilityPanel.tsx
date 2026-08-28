import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Link as LinkIcon,
  Moon,
  RotateCcw,
  SlidersHorizontal,
  SunMedium,
  X,
} from 'lucide-react';
import {
  type AccessibilityTheme,
  type TextScale,
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  useAccessibilityPreferences,
} from './preferences';

const THEME_OPTIONS: Array<{
  value: AccessibilityTheme;
  label: string;
  description: string;
  icon: typeof SunMedium;
}> = [
  { value: 'light', label: 'Light', description: 'Bright, clear workspace', icon: SunMedium },
  { value: 'dark', label: 'Dark', description: 'Low-glare workspace with high readability', icon: Moon },
];

const TEXT_SCALE_OPTIONS: Array<{ value: TextScale; label: string }> = [
  { value: 'default', label: '100%' },
  { value: 'large', label: '112%' },
  { value: 'larger', label: '125%' },
];

interface PreferenceToggleProps {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}

function PreferenceToggle({ checked, description, label, onChange }: PreferenceToggleProps) {
  return (
    <label className="accessibility-toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="accessibility-switch" aria-hidden="true"><span /></span>
    </label>
  );
}

export default function AccessibilityPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const { preferences, updatePreferences } = useAccessibilityPreferences();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const closePanel = () => {
    setIsOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className="accessibility-control">
      <button
        ref={triggerRef}
        type="button"
        className="header-icon-button"
        aria-label="Open display settings"
        aria-expanded={isOpen}
        aria-controls="accessibility-preferences"
        onClick={() => setIsOpen((open) => !open)}
      >
        <SlidersHorizontal size={17} aria-hidden="true" />
        <span>Display</span>
      </button>

      {isOpen && (
        <>
          <div className="accessibility-backdrop" aria-hidden="true" onMouseDown={closePanel} />
          <div
            ref={panelRef}
            id="accessibility-preferences"
            className="accessibility-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="accessibility-panel-title"
            aria-describedby="accessibility-panel-note"
          >
          <div className="accessibility-panel__header">
            <div>
              <p className="section-label">Personalise your workspace</p>
              <h2 id="accessibility-panel-title">Display settings</h2>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="icon-button"
              aria-label="Close display settings"
              onClick={closePanel}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>

          <fieldset className="accessibility-fieldset">
            <legend>Colour theme</legend>
            <div className="theme-option-grid">
              {THEME_OPTIONS.map((option) => {
                const Icon = option.icon;
                const selected = preferences.theme === option.value;
                return (
                  <label key={option.value} className={`theme-option theme-option--${option.value} ${selected ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="accessibility-theme"
                      value={option.value}
                      checked={selected}
                      onChange={() => updatePreferences({ theme: option.value })}
                    />
                    <span className="theme-option__icon"><Icon size={16} aria-hidden="true" /></span>
                    <span className="theme-option__copy">
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    {selected && <Check className="theme-option__check" size={15} aria-hidden="true" />}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="accessibility-fieldset accessibility-fieldset--compact">
            <legend>Text size</legend>
            <div className="text-scale-options">
              {TEXT_SCALE_OPTIONS.map((option) => (
                <label key={option.value} className={preferences.textScale === option.value ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="text-scale"
                    value={option.value}
                    checked={preferences.textScale === option.value}
                    onChange={() => updatePreferences({ textScale: option.value })}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="accessibility-toggle-list">
            <PreferenceToggle
              label="Reduce motion"
              description="Minimise transitions and movement"
              checked={preferences.reduceMotion}
              onChange={(reduceMotion) => updatePreferences({ reduceMotion })}
            />
            <PreferenceToggle
              label="Enhanced focus"
              description="Use a thicker keyboard focus indicator"
              checked={preferences.enhancedFocus}
              onChange={(enhancedFocus) => updatePreferences({ enhancedFocus })}
            />
            <PreferenceToggle
              label="Underline links"
              description="Make text links easier to identify"
              checked={preferences.underlineLinks}
              onChange={(underlineLinks) => updatePreferences({ underlineLinks })}
            />
          </div>

          <button type="button" className="btn btn-sm accessibility-reset" onClick={() => updatePreferences(DEFAULT_ACCESSIBILITY_PREFERENCES)}>
            <RotateCcw size={14} aria-hidden="true" /> Reset preferences
          </button>
          <p id="accessibility-panel-note" className="accessibility-panel__note" aria-live="polite"><LinkIcon size={12} aria-hidden="true" /> {THEME_OPTIONS.find(option => option.value === preferences.theme)?.label}, {TEXT_SCALE_OPTIONS.find(option => option.value === preferences.textScale)?.label} text. Saved automatically.</p>
          </div>
        </>
      )}
    </div>
  );
}
