"use client";
import { useEffect } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
};

const DEFAULT_DESCRIPTION = "Cushion's live actions open to whitelist members in the upcoming alpha. Add your wallet to the waitlist to get early access.";

export function ActionModal({ open, onClose, title, description }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="action-modal-backdrop" onClick={onClose}>
      <style>{`
        .action-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(10, 13, 17, 0.72);
          backdrop-filter: blur(6px);
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          animation: fade-in 160ms ease-out;
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .action-modal {
          background: var(--surface);
          border: 1px solid var(--border-strong);
          border-radius: 16px;
          padding: 32px;
          max-width: 460px;
          width: 100%;
          position: relative;
          animation: slide-up 240ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        @keyframes slide-up {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .action-modal::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: 16px;
          background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 30%);
          pointer-events: none;
        }
        .action-modal-eyebrow {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--accent);
          margin-bottom: 12px;
          position: relative;
        }
        .action-modal-title {
          font-family: var(--font-display);
          font-size: 28px;
          line-height: 1.1;
          color: var(--fg);
          margin-bottom: 16px;
          letter-spacing: -0.01em;
          position: relative;
        }
        .action-modal-desc {
          font-size: 14px;
          color: var(--fg-muted);
          line-height: 1.6;
          margin-bottom: 28px;
          position: relative;
        }
        .action-modal-actions {
          display: flex;
          gap: 12px;
          position: relative;
          flex-wrap: wrap;
        }
        .action-modal-btn-primary {
          flex: 1;
          padding: 12px 20px;
          background: var(--accent);
          color: var(--bg);
          border: 1px solid var(--accent);
          border-radius: 999px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: background 160ms ease;
          text-align: center;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .action-modal-btn-primary:hover {
          background: var(--accent-dim);
        }
        .action-modal-btn-secondary {
          padding: 12px 20px;
          background: transparent;
          color: var(--fg-muted);
          border: 1px solid var(--border-strong);
          border-radius: 999px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: color 160ms ease, border-color 160ms ease;
        }
        .action-modal-btn-secondary:hover {
          color: var(--fg);
          border-color: var(--fg-muted);
        }
      `}</style>
      <div className="action-modal" onClick={e => e.stopPropagation()}>
        <div className="action-modal-eyebrow">Available in alpha</div>
        <h2 className="action-modal-title">{title}</h2>
        <p className="action-modal-desc">{description || DEFAULT_DESCRIPTION}</p>
        <div className="action-modal-actions">
          <a
            href="https://www.cushionfi.xyz/waitlist"
            target="_blank"
            rel="noreferrer"
            className="action-modal-btn-primary"
          >
            Join the waitlist →
          </a>
          <button className="action-modal-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
