"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  api,
  getStoredWorkspaceId,
  getToken,
  setStoredWorkspaceId,
  setToken,
  type MeResponse,
  type User,
  type Workspace,
} from "./api";

interface AuthState {
  loading: boolean;
  user: User | null;
  workspaces: Workspace[];
  workspace: Workspace | null;
  selectWorkspace: (id: string) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  loading: true,
  user: null,
  workspaces: [],
  workspace: null,
  selectWorkspace: () => {},
  logout: async () => {},
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setLoading(false);
      setUser(null);
      setWorkspaces([]);
      return;
    }
    try {
      const me = await api<MeResponse>("/auth/me");
      setUser(me.user);
      setWorkspaces(me.workspaces);
      const stored = getStoredWorkspaceId();
      const valid = me.workspaces.some((w) => w.id === stored);
      const chosen =
        (valid ? stored : null) ??
        me.user.currentWorkspaceId ??
        me.workspaces[0]?.id ??
        null;
      if (chosen) {
        setWorkspaceId(chosen);
        setStoredWorkspaceId(chosen);
      }
    } catch {
      setToken(null);
      setUser(null);
      setWorkspaces([]);
      setWorkspaceId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    setStoredWorkspaceId(id);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // ignore — token is cleared regardless
    }
    setToken(null);
    setUser(null);
    setWorkspaces([]);
    setWorkspaceId(null);
    router.push("/login");
  }, [router]);

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId]
  );

  const value = useMemo(
    () => ({ loading, user, workspaces, workspace, selectWorkspace, logout, refresh }),
    [loading, user, workspaces, workspace, selectWorkspace, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

/** Renders children only when authenticated; otherwise redirects to /login. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { loading, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) return <div className="container muted">Loading…</div>;
  if (!user) return null;
  return <>{children}</>;
}
