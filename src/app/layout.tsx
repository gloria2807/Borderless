import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Borderless",
  description: "Autonomous household utilities agent — Stellar testnet demo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
