"use client";
import type { ReactNode } from 'react';

type Variant = 'primary' | 'secondary';

type Props = {
  variant?: Variant;
  onClick: () => void;
  children: ReactNode;
  fullWidth?: boolean;
};

export function ActionButton({ variant = 'secondary', onClick, children, fullWidth = false }: Props) {
  return (
    <button
      className={`cushion-action-btn ${variant} ${fullWidth ? 'full' : ''}`}
      onClick={onClick}
    >
      <style>{`
        .cushion-action-btn {
          padding: 12px 20px;
          border-radius: 999px;
          font-size: 14px;
          font-weight: 500;
          font-family: var(--font-body);
          cursor: pointer;
          transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
          letter-spacing: -0.01em;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          white-space: nowrap;
        }
        .cushion-action-btn.full {
          width: 100%;
        }
        .cushion-action-btn.primary {
          background: var(--accent);
          color: var(--bg);
          border: 1px solid var(--accent);
        }
        .cushion-action-btn.primary:hover {
          background: var(--accent-dim);
          border-color: var(--accent-dim);
        }
        .cushion-action-btn.secondary {
          background: transparent;
          color: var(--accent);
          border: 1px solid var(--accent-border);
        }
        .cushion-action-btn.secondary:hover {
          background: var(--accent-soft);
          border-color: var(--accent);
        }
      `}</style>
      {children}
    </button>
  );
}
