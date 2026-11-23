import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Me, OrgRole } from '@survey/contracts';
import { ApiError, get, post, setSession } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const setMe = useCallback((next: Me | null) => {
    setSession(next);
    setMeState(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMe(await get<Me>('/auth/me'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setMe(null);
      else throw error;
    } finally {
      setLoading(false);
    }
  }, [setMe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await post('/auth/logout').catch(() => {});
    setMe(null);
    queryClient.clear();
  }, [queryClient, setMe]);

  const switchOrg = useCallback(
    async (orgId: string) => {
      setMe(await post<Me>('/auth/switch-org', { orgId }));
      queryClient.clear();
    },
    [queryClient, setMe],
  );

  return (
    <AuthContext.Provider value={{ me, loading, setMe, refresh, logout, switchOrg }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export function useOrgRole(): OrgRole | null {
  return useAuth().me?.activeOrg?.role ?? null;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8 text-muted">Loading…</div>;
  if (!me)
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}
