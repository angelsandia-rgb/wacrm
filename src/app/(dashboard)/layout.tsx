import type { Metadata } from "next";
import { DashboardShell } from "./dashboard-shell";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. The proxy (`src/proxy.ts`) redirects
// unauthenticated visitors to /login, so crawlers never see these pages
// — this is belt-and-suspenders, but SEO-critical if a URL ever leaks
// via a link shared externally (there is no robots.txt in this app).
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardShell>{children}</DashboardShell>;
}
