import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Exvade Pulse",
  description: "Internal operating system for Exvade Bioscience",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
