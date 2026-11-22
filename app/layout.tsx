import type { Metadata } from "next";
import "./globals.css";

// SITE_URL (e.g. https://akivab.github.io/op1-loops) makes the share-card URLs
// absolute, which link previews need; the Pages workflow sets it.
const site = process.env.SITE_URL?.replace(/\/$/, "");
const title = "OP-1 Loops";
const description = "Loops from my OP-1. Play them in your browser.";
// ?v= busts link-preview caches: bump it when public/og.png changes
const cardUrl = `${site}/og.png?v=2`;

export const metadata: Metadata = {
  title,
  description,
  ...(site && {
    metadataBase: new URL(`${site}/`),
    openGraph: {
      type: "website",
      url: `${site}/`,
      title,
      description,
      images: [{ url: cardUrl, width: 1200, height: 630, alt: "Two tape reels with four coloured tracks winding between them" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [cardUrl],
    },
  }),
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
