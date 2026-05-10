"use client";
import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
  padding = '24px',
}: {
  children: ReactNode;
  className?: string;
  padding?: string;
}) {
  return (
    <div className={`cushion-card ${className}`} style={{ padding }}>
      <style>{`
        .cushion-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          position: relative;
        }
        .cushion-card::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: 12px;
          background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 30%);
          pointer-events: none;
        }
      `}</style>
      {children}
    </div>
  );
}
