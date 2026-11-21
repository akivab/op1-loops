import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OP-1 Loops",
  description: "Four-track loops from the OP-1 field tapes, playable in the browser.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
