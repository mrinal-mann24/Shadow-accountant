import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Shadow Accountant", template: "%s | Shadow Accountant" },
  description: "Client operations for AI Accountant Virtual Accounting",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. Storylane) add classes to <html> before React
    // loads. This only ignores attribute differences on <html> itself, not on anything inside it.
    <html lang="en-IN" suppressHydrationWarning>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
