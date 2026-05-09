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
        }
      `}</style>
      {children}
    </div>
  );
}
