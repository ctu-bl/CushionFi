"use client";

export function DemoBanner() {
  return (
    <div className="demo-banner">
      <style>{`
        .demo-banner {
          background: var(--accent-soft);
          border-bottom: 1px solid var(--accent-border);
          padding: 10px 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--fg);
          text-align: center;
          line-height: 1.5;
          flex-wrap: wrap;
        }
        .demo-banner-dot {
          width: 6px;
          height: 6px;
          background: var(--accent);
          border-radius: 50%;
          animation: pulse-dot 2s ease-in-out infinite;
          flex-shrink: 0;
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .demo-banner-link {
          color: var(--accent);
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .demo-banner-link:hover {
          color: var(--accent-dim);
        }
        @media (max-width: 600px) {
          .demo-banner { font-size: 11px; padding: 8px 16px; }
        }
      `}</style>
      <span className="demo-banner-dot" />
      <span>
        You're viewing an interactive demo. Live trading opens to whitelist members soon.{' '}
        <a
          href="https://www.cushionfi.xyz/waitlist"
          target="_blank"
          rel="noreferrer"
          className="demo-banner-link"
        >
          Join the waitlist →
        </a>
      </span>
    </div>
  );
}
