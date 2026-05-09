"use client";
import Link from 'next/link';

export function AppNav() {
  return (
    <nav className="app-nav">
      <style>{`
        .app-nav {
          height: 64px;
          border-bottom: 1px solid var(--border);
          background: var(--bg);
          padding: 0 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          position: sticky;
          top: 0;
          z-index: 10;
        }
        .app-nav-logo img {
          height: 22px;
          display: block;
        }
        .app-nav-pill {
          font-family: var(--font-mono);
          font-size: 11px;
          padding: 4px 10px;
          border: 1px solid var(--accent-border);
          background: var(--accent-soft);
          color: var(--accent);
          border-radius: 999px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .app-nav-links {
          display: flex;
          gap: 24px;
          align-items: center;
        }
        .app-nav-link {
          font-size: 14px;
          color: var(--fg-muted);
          transition: color 120ms ease;
        }
        .app-nav-link:hover {
          color: var(--fg);
        }
      `}</style>

      <Link href="/positions/demo" className="app-nav-logo">
        <img src="/logo.svg" alt="Cushion" />
      </Link>

      <span className="app-nav-pill">Demo Mode</span>

      <div className="app-nav-links">
        <Link href="/vault" className="app-nav-link">Vault</Link>
        <a
          href="https://github.com/ctu-bl/CushionFi"
          target="_blank"
          rel="noreferrer"
          className="app-nav-link"
        >
          GitHub →
        </a>
      </div>
    </nav>
  );
}
