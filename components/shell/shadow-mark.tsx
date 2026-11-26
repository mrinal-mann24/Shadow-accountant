/** The Shadow logo mark: a black rounded square with the white figure. */
export function ShadowMark({ className = "size-8" }: { className?: string }) {
  return (
    <span className={`${className} flex shrink-0 items-center justify-center rounded-[10px] bg-ink`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M4 17c3-6 13-6 16 0" />
        <circle cx="12" cy="9" r="3" />
      </svg>
    </span>
  );
}
