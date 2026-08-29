import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Building2, CircleUserRound, FilePlus, Home, Package, ReceiptText, Search, Settings, Tags, UserSearch, Users, X } from 'lucide-react';
import { useApp, type Screen } from '../context/AppContext';
import { OPEN_COMMAND_PALETTE_EVENT } from './commandPaletteEvents';

export interface CommandDefinition {
  label: string;
  detail: string;
  icon: ReactNode;
  run: () => void;
  group?: string;
  keywords?: string;
  searchOnly?: boolean;
}

interface CommandPaletteProps {
  commands?: CommandDefinition[];
  contextLabel?: string;
  placeholder?: string;
  emptyLabel?: string;
}

export default function CommandPalette({ commands: suppliedCommands, contextLabel = 'Pharmacy operations', placeholder = 'Search patients, orders, products or actions…', emptyLabel = 'No matching result' }: CommandPaletteProps = {}) {
  const { state, dispatch } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const navigate = (screen: Screen) => {
    dispatch({ type: 'SET_SCREEN', screen });
    setOpen(false);
  };

  const navigateTo = (screen: Screen, target: NonNullable<typeof state.navigationTarget>) => {
    dispatch({ type: 'SET_NAVIGATION_TARGET', target });
    navigate(screen);
  };

  const defaultCommands: CommandDefinition[] = [
    { label: 'Open overview', detail: 'Today’s position and priority queue', group: 'Navigate', icon: <Home size={16} />, run: () => navigate('home') },
    { label: 'Patients hub', detail: 'CRM for enquiries, referred patients and order status', group: 'Navigate', keywords: 'find patient directory crm', icon: <UserSearch size={16} />, run: () => navigate('patients') },
    { label: 'Orders', detail: 'Payments, Curaleaf progress, delivery and collection', group: 'Navigate', keywords: 'billing track supplier provider prescription fulfilment', icon: <Package size={16} />, run: () => navigate('orders') },
    { label: 'Curaleaf catalogue', detail: 'Products, pack sizes and patient prices', group: 'Navigate', icon: <Tags size={16} />, run: () => navigate('formulary') },
    { label: 'Organisation settings', detail: 'Setup, payment routes, forms, QR assets and pharmacy identity', group: 'Navigate', keywords: 'resources eligibility content pack', icon: <Settings size={16} />, run: () => navigate('settings') },
    { label: 'Start a prescription', detail: 'Create a new draft session', group: 'Actions', icon: <FilePlus size={16} />, run: () => { dispatch({ type: 'NEW_ORDER' }); navigate('create'); } },
    { label: 'Open patient records', detail: 'See patients activated for this pharmacy by HHH', group: 'Actions', icon: <Users size={16} />, run: () => navigate('patients') },
  ];

  const needle = query.trim().toLowerCase();
  const entityCommands: CommandDefinition[] = (() => {
    if (!open || suppliedCommands || needle.length < 2) return [];
    const organisationId = state.currentOrganisationId;
    const people = new Map<string, { id: string; name: string; email: string; mobile: string; dob: string }>();
    state.crm.filter(patient => patient.organisationId === organisationId).forEach(patient => {
      people.set(patient.email.toLowerCase(), { id: patient.id, name: patient.name, email: patient.email, mobile: patient.mobile, dob: patient.dob ?? '' });
    });
    const patientCommands = [...people.values()]
      .filter(patient => `${patient.name} ${patient.email} ${patient.mobile} ${patient.dob}`.toLowerCase().includes(needle))
      .map((patient): CommandDefinition => ({
        label: patient.name,
        detail: `${patient.email} · ${patient.mobile}`,
        keywords: `${patient.dob} patient`,
        group: 'Patients',
        searchOnly: true,
        icon: <CircleUserRound size={16} />,
        run: () => navigateTo('patients', { kind: 'patient', id: patient.id }),
      }));
    const orderCommands = state.orders
      .filter(order => order.organisationId === organisationId && order.prescriptions.length)
      .filter(order => {
        const patient = state.crm.find(item => item.id === order.patientId && item.organisationId === organisationId);
        return `order ${order.id} ${patient?.name ?? ''} ${patient?.email ?? ''} ${patient?.mobile ?? ''} ${order.prescriptions.map(rx => rx.purchaseOrderId ?? '').join(' ')}`.toLowerCase().includes(needle);
      })
      .map((order): CommandDefinition => {
        const patient = state.crm.find(item => item.id === order.patientId && item.organisationId === organisationId);
        return {
          label: `Order #${order.id}`,
          detail: `${patient?.name ?? 'Unassigned patient'} · ${order.prescriptions.length} prescription${order.prescriptions.length === 1 ? '' : 's'}`,
          keywords: `${patient?.email ?? ''} ${patient?.mobile ?? ''} ${order.prescriptions.map(rx => rx.purchaseOrderId ?? '').join(' ')}`,
          group: 'Orders',
          searchOnly: true,
          icon: <ReceiptText size={16} />,
          run: () => navigateTo('orders', { kind: 'order', key: `${order.id}-${order.prescriptions[0].id}` }),
        };
      });
    const catalogueCommands = state.catalogue
      .filter(product => `${product.name} ${product.type} ${product.unit ?? ''}`.toLowerCase().includes(needle))
      .map((product): CommandDefinition => ({
        label: product.name,
        detail: `${product.packSize ?? '—'} ${product.unit ?? 'units'} · Curaleaf catalogue`,
        keywords: `${product.type} product medicine`,
        group: 'Catalogue',
        searchOnly: true,
        icon: <Tags size={16} />,
        run: () => navigateTo('formulary', { kind: 'catalogue', query: product.name }),
      }));
    return [...patientCommands, ...orderCommands, ...catalogueCommands];
  })();

  const commands = suppliedCommands ?? [...defaultCommands, ...entityCommands];
  const results = commands
    .filter(command => (!command.searchOnly || needle.length >= 2) && `${command.label} ${command.detail} ${command.keywords ?? ''}`.toLowerCase().includes(needle))
    .slice(0, 18);

  const execute = (command: CommandDefinition) => {
    setOpen(false);
    command.run();
  };

  useEffect(() => {
    const show = () => {
      if (document.querySelector('[aria-modal="true"]')) return;
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
      setQuery('');
      setActiveIndex(0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        show();
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, show);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, show);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (open) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    returnFocusRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !paletteRef.current) return;
      const focusable = Array.from(paletteRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  if (!open) return null;

  return (
    <div className="command-palette-backdrop" onMouseDown={() => setOpen(false)}>
      <section ref={paletteRef} className="command-palette" role="dialog" aria-modal="true" aria-label={`${contextLabel} commands`} aria-describedby="command-palette-help" onMouseDown={event => event.stopPropagation()}>
        <div className="command-palette__search">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => Math.min(index + 1, results.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => Math.max(index - 1, 0)); }
              if (event.key === 'Enter' && results[activeIndex]) execute(results[activeIndex]);
            }}
            placeholder={placeholder}
            aria-label={`Search ${contextLabel.toLowerCase()} commands`}
          />
          <button onClick={() => setOpen(false)} aria-label="Close command palette"><X size={15} /></button>
        </div>
        <div id="command-palette-help" className="command-palette__meta"><span>{contextLabel}<em>Live workspace search</em></span><kbd>↑↓</kbd><small>navigate</small><kbd>↵</kbd><small>open</small></div>
        <div className="command-palette__results" aria-live="polite">
          {results.map((command, index) => (
            <Fragment key={`${command.group ?? 'Commands'}-${command.label}-${index}`}>
              {(index === 0 || results[index - 1]?.group !== command.group) && <div className="command-palette__group-label">{command.group ?? 'Commands'}</div>}
              <button
                className={activeIndex === index ? 'active' : ''}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => execute(command)}
                aria-current={activeIndex === index ? 'true' : undefined}
              >
                <span>{command.icon}</span>
                <span><strong>{command.label}</strong><small>{command.detail}</small></span>
                <kbd>↵</kbd>
              </button>
            </Fragment>
          ))}
          {results.length === 0 && <div className="command-palette__empty"><Building2 size={18} /><span>{emptyLabel}</span></div>}
        </div>
      </section>
    </div>
  );
}
