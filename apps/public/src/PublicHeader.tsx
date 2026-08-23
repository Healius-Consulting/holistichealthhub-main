import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Menu, X } from 'lucide-react';
import { isModifiedClick, navigatePublic, usePublicLocation } from './publicLocation';

const MARK = '/holistic-health-hub-mark.png';

export function PublicLink({ href, children, className = '', onClick, target, ...props }: { href: string; children: ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      className={className}
      href={href}
      target={target}
      onClick={event => {
        onClick?.(event);
        if (event.defaultPrevented || target === '_blank' || isModifiedClick(event)) return;
        const url = new URL(href, window.location.origin);
        if (url.origin !== window.location.origin) return;
        event.preventDefault();
        navigatePublic(href);
      }}
      {...props}
    >
      {children}
    </a>
  );
}

export function PublicHeader() {
  const [open, setOpen] = useState(false);
  const location = usePublicLocation();
  const path = location.pathname.replace(/\/+$/, '') || '/';

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);

  return (
    <header className="hhh-header">
      <div className="hhh-header__inner">
        <PublicLink href="/" className="hhh-mark" aria-label="Holistic Health Hub Home">
          <img src={MARK} alt="Holistic Health Hub Emblem" width="48" height="48" />
          <span>
            <strong>Holistic Health Hub</strong>
            <small>Personalised healthcare</small>
          </span>
        </PublicLink>
        <button
          className="hhh-menu-toggle"
          type="button"
          aria-expanded={open}
          aria-controls="public-navigation"
          onClick={() => setOpen(value => !value)}
        >
          {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          <span className="sr-only">Toggle Navigation Menu</span>
        </button>
        <nav id="public-navigation" className={`hhh-nav ${open ? 'is-open' : ''}`} aria-label="Primary navigation">
          <PublicLink href="/" className={path === '/' ? 'is-active' : ''}>Home</PublicLink>
          <PublicLink href="/how-it-works" className={path === '/how-it-works' ? 'is-active' : ''}>How it works</PublicLink>
          <PublicLink href="/conditions" className={path === '/conditions' ? 'is-active' : ''}>Conditions</PublicLink>
          <PublicLink href="/about" className={path === '/about' ? 'is-active' : ''}>About</PublicLink>
          <PublicLink href="/blog" className={path.startsWith('/blog') || path.startsWith('/post/') ? 'is-active' : ''}>Journal</PublicLink>
          <PublicLink href="/faq" className={path === '/faq' ? 'is-active' : ''}>FAQs</PublicLink>
          <PublicLink href="/eligibility" className="hhh-button hhh-button--rust hhh-nav__cta">
            Check eligibility <ArrowRight aria-hidden="true" />
          </PublicLink>
        </nav>
      </div>
    </header>
  );
}
