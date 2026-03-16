"use client";

// global-error.tsx catches errors thrown in the root layout (app/layout.tsx) itself.
// Must include <html> and <body> since it replaces the full document.

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="antialiased" style={{ margin: 0 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100dvh",
            gap: "1rem",
            padding: "2rem",
            background: "#0b0d12",
            color: "rgba(255,255,255,0.7)",
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: "0.875rem", margin: 0 }}>Something went wrong. Reload the page to try again.</p>
          <button
            onClick={reset}
            style={{
              padding: "0.4rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.8)",
              fontSize: "0.8125rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
