"use client";
/**
 * A dialog rendered at the document root. Panels animate with transforms, and a transformed
 * ancestor traps `position: fixed` children inside itself — which is how a dialog opened from
 * a side panel ended up clipped to that panel. Rendering through a portal avoids that.
 */
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function Modal({ onClose, className = "", dismissable = true, children }: { onClose(): void; className?: string; dismissable?: boolean; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.body);
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape" && dismissable) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dismissable]);
  if (!host) return null;
  return createPortal(
    <div className="modal-veil" onClick={dismissable ? onClose : undefined}>
      <div className={`glass modal ${className}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>,
    host,
  );
}
