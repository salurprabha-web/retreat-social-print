import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Retreat Social Print", description: "Capture. Customize. Share. Print." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
