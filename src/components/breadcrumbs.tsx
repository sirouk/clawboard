import Link from "next/link";

export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="flex items-center gap-2">
          {item.href ? (
            <Link className="hover:text-[rgb(var(--claw-text))]" href={item.href}>
              {item.label}
            </Link>
          ) : (
            <span className="text-[rgb(var(--claw-text))]">{item.label}</span>
          )}
          {index < items.length - 1 && <span>/</span>}
        </span>
      ))}
    </nav>
  );
}
