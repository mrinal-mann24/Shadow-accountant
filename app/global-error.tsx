"use client";
// Last-resort error page (used when the root layout itself fails). Must render its own <html> and <body>.
export default function GlobalError({
  reset,
}: {
  error: unknown;
  reset?: () => void;
}) {
  return (
    <html lang="en-IN">
      <body
        style={{
          fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
          background: "#ffffff",
          color: "#000000",
        }}
      >
        <main style={{ maxWidth: 480, margin: "15vh auto", padding: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ color: "#666666", marginTop: 8 }}>
            Shadow Accountant could not load this page. Please try again. If it
            keeps happening, tell the engineering team.
          </p>
          {reset && (
            <button
              type="button"
              onClick={reset}
              style={{
                marginTop: 16,
                background: "#314DD0",
                color: "#ffffff",
                border: 0,
                borderRadius: 6,
                padding: "8px 16px",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          )}
        </main>
      </body>
    </html>
  );
}
