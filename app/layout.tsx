import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import { themeScript } from "../lib/theme";
import { SmoothScrolling } from "../components/smooth-scrolling";
import "lenis/dist/lenis.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "optional",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "optional",
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "optional",
});

export const metadata: Metadata = {
  title: "Chrona",
  description: "A time-aware research assistant for past conversations and present-day answers.",
  icons: { icon: [{ url: "/chrona-logo.png", type: "image/png" }], apple: "/chrona-logo.png" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Script id="theme-initializer" strategy="beforeInteractive">{themeScript}</Script>
        <SmoothScrolling />{children}
      </body>
    </html>
  );
}
