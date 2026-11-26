/**
 * The Shadow Accountant logo: three ledger bars (the accountant) with an offset blue shadow (the shadow),
 * white on a black rounded square. The same drawing is the browser tab icon in `app/icon.svg`.
 */
export function ShadowMark({ className = "size-8" }: { className?: string }) {
  return (
    <span className={`${className} flex shrink-0 items-center justify-center rounded-[10px] bg-ink`}>
      <svg viewBox="0 0 24 24" className="size-[72%]" aria-hidden>
        <g fill="#6B83F2">
          <rect x="6.6" y="13.6" width="3.2" height="6.4" rx="0.9" />
          <rect x="11.4" y="10.6" width="3.2" height="9.4" rx="0.9" />
          <rect x="16.2" y="7.6" width="3.2" height="12.4" rx="0.9" />
        </g>
        <g fill="#FFFFFF">
          <rect x="5.2" y="12.2" width="3.2" height="6.4" rx="0.9" />
          <rect x="10" y="9.2" width="3.2" height="9.4" rx="0.9" />
          <rect x="14.8" y="6.2" width="3.2" height="12.4" rx="0.9" />
        </g>
      </svg>
    </span>
  );
}

/** Logo mark plus the product name, for the sidebar and the phone top bar. */
export function ShadowWordmark({ markClassName, textClassName = "text-[15px]" }: { markClassName?: string; textClassName?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <ShadowMark className={markClassName} />
      <span className={`${textClassName} font-semibold tracking-tight whitespace-nowrap`}>
        Shadow <span className="font-medium text-muted-foreground">Accountant</span>
      </span>
    </span>
  );
}
