import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veritas Dashboard",
  description: "Manage payment verification — API keys, payouts, payment links, webhooks.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
