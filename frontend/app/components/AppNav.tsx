"use client";
import { useState } from 'react';
import Link from 'next/link';
import { ActionButton } from './ActionButton';
import { ActionModal } from './ActionModal';

export function AppNav() {
  const [wrapModalOpen, setWrapModalOpen] = useState(false);

  return (
    <>
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
            gap: 16px;
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
          @media (max-width: 700px) {
            .app-nav { padding: 0 16px; }
            .app-nav-pill { display: none; }
            .app-nav-links .cushion-action-btn {
              padding: 8px 14px;
              font-size: 12px;
            }
          }
        `}</style>

        <Link href="/positions/demo" className="app-nav-logo">
          <img src="/logo.svg" alt="Cushion" />
        </Link>

        <span className="app-nav-pill">Demo Mode</span>

        <div className="app-nav-links">
          <ActionButton variant="primary" onClick={() => setWrapModalOpen(true)}>
            Wrap a position
          </ActionButton>
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

      <ActionModal
        open={wrapModalOpen}
        onClose={() => setWrapModalOpen(false)}
        title="Wrap a new position"
        description="Wrapping live DeFi loans with Cushion opens to whitelist members in the upcoming alpha. Add your wallet to the waitlist to get early access."
      />
    </>
  );
}
