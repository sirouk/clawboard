"use client";

// error.tsx catches render errors in page segments below the root layout.
// The root AppShell and nav remain intact; only the page content area is replaced.

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "40dvh",
        gap: "1rem",
        padding: "2rem",
        color: "rgba(255,255,255,0.6)",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
      }}
    >
      <p style={{ fontSize: "0.875rem", margin: 0 }}>Something went wrong loading this page.</p>
      <button
        onClick={reset}
        style={{
          padding: "0.4rem 1rem",
          borderRadius: "0.375rem",
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(255,255,255,0.05)",
          color: "rgba(255,255,255,0.7)",
          fontSize: "0.8125rem",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
