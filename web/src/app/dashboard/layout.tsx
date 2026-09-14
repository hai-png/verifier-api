"use client";

import Nav from "@/components/Nav";
import { AuthProvider, RequireAuth } from "@/lib/useAuth";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <RequireAuth>
        <Nav />
        <div className="container">{children}</div>
      </RequireAuth>
    </AuthProvider>
  );
}
