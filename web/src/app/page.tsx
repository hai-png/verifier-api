/**
 * Noveld Pay — Payment Platform Dashboard
 *
 * Full-featured dashboard for the self-hosted Ethiopian payment verification
 * platform. Any app developer can:
 *   1. Sign up (email/password)
 *   2. Create workspaces (each workspace = one app)
 *   3. Generate API keys
 *   4. Configure payout accounts (Telebirr/CBE/etc.)
 *   5. Create hosted payment links
 *   6. View revenue analytics + payment history
 *   7. Set up webhooks for real-time payment notifications
 *
 * The dashboard is a client-side SPA that calls the verifier-api (deployed
 * on Render) for all data. No server-side database — the dashboard is
 * stateless and deployed on Cloudflare Pages.
 */

'use client'

import { useState, useEffect, createContext, useContext, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { ToastProvider } from '@/components/ui/toast'
import {
  LayoutDashboard, Key, Wallet, Link2, CreditCard, Webhook, Settings,
  LogOut, Plus, Trash2, Copy, Check, TrendingUp, DollarSign, ShoppingCart,
  Users, ArrowRight, Menu, X, Eye, EyeOff, AlertCircle, CheckCircle2,
  Loader2, Building2, ChevronRight, BarChart3
} from 'lucide-react'

// ─── API Config ─────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://verifier-api-selfhosted.onrender.com'

// ─── Types ──────────────────────────────────────────────────────────────────

interface User {
  id: string
  email: string
  name: string
}

interface Workspace {
  id: string
  name: string
  tier: string
  verificationCredits: number
  imageCredits: number
  createdAt: string
  role: string
  _count?: {
    apiKeys: number
    paymentLinks: number
    orders: number
    payoutAccounts: number
    webhooks: number
  }
}

interface ApiKey {
  id: string
  prefix: string
  usageCount: number
  lastUsed: string | null
  isActive: boolean
  createdAt: string
  permissions: string[]
}

interface PayoutAccount {
  id: string
  label: string
  accountHolderName: string
  type: 'PHONE' | 'BANK'
  account: string
  providersAllowed: string[]
  isDefault: boolean
}

interface PaymentLink {
  id: string
  name: string
  mode: string
  fixedAmount: number
  acceptedProviders: string[]
  status: string
  redirectUrl: string | null
  createdAt: string
  _count?: { orders: number }
}

interface Payment {
  id: string
  reference: string
  provider: string
  amountPaid: number
  status: string
  buyerName: string | null
  buyerEmail: string | null
  createdAt: string
  paymentLink?: { name: string }
}

interface Product {
  id: string
  name: string
  price: number
  active: boolean
  acceptedProviders: string[]
  maxBuyers: number | null
  createdAt: string
  payoutAccounts: { id: string; label: string }[]
  _count?: { orders: number }
}

interface WorkspaceStats {
  totalRevenue: number
  totalPayments: number
  revenue30Days: number
  payments30Days: number
  providerStats: Record<string, { count: number; revenue: number }>
  dailyRevenue: { date: string; revenue: number; count: number }[]
}

// ─── Auth Context ───────────────────────────────────────────────────────────

interface AuthState {
  user: User | null
  token: string | null
  loading: boolean
}

const AuthContext = createContext<{
  user: User | null
  token: string | null
  loading: boolean
  login: (email: string, password: string) => Promise<boolean>
  signup: (email: string, password: string, name: string) => Promise<boolean>
  logout: () => void
}>(null as unknown as { user: User | null; token: string | null; loading: boolean; login: (e: string, p: string) => Promise<boolean>; signup: (e: string, p: string, n: string) => Promise<boolean>; logout: () => void })

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    loading: true,
  })

  // Load token from localStorage on mount
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('noveld_token') : null
    if (token) {
      fetch(`${API_BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.user) {
            setState({ user: data.user, token, loading: false })
          } else {
            localStorage.removeItem('noveld_token')
            setState({ user: null, token: null, loading: false })
          }
        })
        .catch(() => setState({ user: null, token: null, loading: false }))
    } else {
      // Use setTimeout to avoid calling setState synchronously within useEffect
      setTimeout(() => setState({ user: null, token: null, loading: false }), 0)
    }
  }, [])

  const login = async (email: string, password: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (data.success) {
        localStorage.setItem('noveld_token', data.token)
        setState({ user: data.user, token: data.token, loading: false })
        return true
      }
      return false
    } catch {
      return false
    }
  }

  const signup = async (email: string, password: string, name: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      })
      const data = await res.json()
      if (data.success) {
        localStorage.setItem('noveld_token', data.token)
        setState({ user: data.user, token: data.token, loading: false })
        return true
      }
      return false
    } catch {
      return false
    }
  }

  const logout = () => {
    localStorage.removeItem('noveld_token')
    setState({ user: null, token: null, loading: false })
  }

  return (
    <AuthContext.Provider value={{ ...state, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

const useAuth = () => useContext(AuthContext)

// ─── API Helper ─────────────────────────────────────────────────────────────

async function apiFetch(path: string, token: string | null, options: RequestInit = {}) {
  if (!token) throw new Error('Not authenticated')
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  })
  return res
}

// ─── Pages ──────────────────────────────────────────────────────────────────

type Page =
  | { name: 'dashboard' }
  | { name: 'workspace'; workspaceId: string; tab?: string }
  | { name: 'createWorkspace' }

function App() {
  const { user, token, loading } = useAuth()
  const [page, setPage] = useState<Page>({ name: 'dashboard' })

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!user) {
    return <AuthPage />
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header onNavigate={setPage} currentPage={page} />
      <main className="flex-1 container mx-auto px-4 py-8 max-w-7xl">
        {page.name === 'dashboard' && <DashboardPage onNavigate={setPage} />}
        {page.name === 'createWorkspace' && <CreateWorkspacePage onNavigate={setPage} />}
        {page.name === 'workspace' && (
          <WorkspacePage workspaceId={page.workspaceId} initialTab={page.tab || 'overview'} onNavigate={setPage} />
        )}
      </main>
      <Footer />
    </div>
  )
}

// ─── Header ─────────────────────────────────────────────────────────────────

function Header({ onNavigate, currentPage }: { onNavigate: (p: Page) => void; currentPage: Page }) {
  const { user, logout } = useAuth()
  const { toast } = useToast()

  return (
    <header className="border-b bg-card sticky top-0 z-50">
      <div className="container mx-auto px-4 max-w-7xl flex items-center justify-between h-14">
        <button
          onClick={() => onNavigate({ name: 'dashboard' })}
          className="flex items-center gap-2 font-bold text-lg"
        >
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center text-primary-foreground">
            <CreditCard className="w-4 h-4" />
          </div>
          Noveld Pay
        </button>

        <div className="flex items-center gap-2">
          {currentPage.name === 'workspace' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate({ name: 'dashboard' })}
            >
              <LayoutDashboard className="w-4 h-4 mr-2" />
              All Apps
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2">
                <Avatar className="w-6 h-6">
                  <AvatarFallback>{user?.name?.[0]?.toUpperCase() || 'U'}</AvatarFallback>
                </Avatar>
                <span className="hidden sm:inline">{user?.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-muted-foreground text-xs">
                {user?.email}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { logout(); toast({ title: 'Logged out' }) }}>
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t bg-card mt-auto">
      <div className="container mx-auto px-4 max-w-7xl py-4 text-center text-sm text-muted-foreground">
        Noveld Pay — Self-hosted Ethiopian Payment Platform ·{' '}
        <a href="/docs" className="hover:text-foreground underline">
          API Docs
        </a>
      </div>
    </footer>
  )
}

// ─── Auth Page (Login + Signup) ─────────────────────────────────────────────

function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { login, signup } = useAuth()
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const success = mode === 'login'
      ? await login(email, password)
      : await signup(email, password, name)

    if (!success) {
      setError(mode === 'login' ? 'Invalid email or password' : 'Signup failed. Email may already be in use.')
    } else {
      toast({ title: mode === 'login' ? 'Welcome back!' : 'Account created!' })
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-primary rounded-xl flex items-center justify-center mb-2">
            <CreditCard className="w-6 h-6 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl">Noveld Pay</CardTitle>
          <CardDescription>
            Self-hosted Ethiopian payment platform
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'login' | 'signup')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Login</TabsTrigger>
              <TabsTrigger value="signup">Sign Up</TabsTrigger>
            </TabsList>
            <TabsContent value={mode}>
              <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                {mode === 'signup' && (
                  <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      required
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 8 characters"
                    minLength={8}
                    required
                  />
                </div>
                {error && (
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="w-4 h-4" />
                    {error}
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {mode === 'login' ? 'Login' : 'Create Account'}
                </Button>
                {mode === 'login' && (
                  <div className="text-center text-sm">
                    <a href="/forgot-password" className="text-muted-foreground underline hover:text-foreground">
                      Forgot your password?
                    </a>
                  </div>
                )}
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
        <CardFooter className="text-center text-xs text-muted-foreground">
          Supports Telebirr, CBE, Dashen, Abyssinia, Awash, Zemen, M-Pesa + 15 more via OCR
        </CardFooter>
      </Card>
    </div>
  )
}

// ─── Dashboard Page (workspace list + summary) ──────────────────────────────

function DashboardPage({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { token } = useAuth()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    apiFetch('/workspaces', token)
      .then(res => res.json())
      .then(data => {
        if (data.success) setWorkspaces(data.workspaces)
      })
      .finally(() => setLoading(false))
  }, [token])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Your Apps</h1>
          <p className="text-muted-foreground mt-1">
            Each workspace is a separate app integration with its own API keys, payouts, and payment links.
          </p>
        </div>
        <Button onClick={() => onNavigate({ name: 'createWorkspace' })}>
          <Plus className="w-4 h-4 mr-2" />
          New App
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : workspaces.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Building2 className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold">No apps yet</h3>
            <p className="text-muted-foreground mb-4">Create your first app workspace to get started.</p>
            <Button onClick={() => onNavigate({ name: 'createWorkspace' })}>
              <Plus className="w-4 h-4 mr-2" />
              Create App
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {workspaces.map(ws => (
            <WorkspaceCard key={ws.id} workspace={ws} onClick={() => onNavigate({ name: 'workspace', workspaceId: ws.id })} />
          ))}
        </div>
      )}
    </div>
  )
}

function WorkspaceCard({ workspace, onClick }: { workspace: Workspace; onClick: () => void }) {
  return (
    <Card className="cursor-pointer hover:border-primary transition-colors" onClick={onClick}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base">{workspace.name}</CardTitle>
              <Badge variant="secondary" className="text-xs">{workspace.tier}</Badge>
            </div>
          </div>
          <ChevronRight className="w-5 h-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-2xl font-bold">{workspace._count?.apiKeys ?? 0}</div>
            <div className="text-xs text-muted-foreground">API Keys</div>
          </div>
          <div>
            <div className="text-2xl font-bold">{workspace._count?.orders ?? 0}</div>
            <div className="text-xs text-muted-foreground">Payments</div>
          </div>
          <div>
            <div className="text-2xl font-bold">{workspace._count?.paymentLinks ?? 0}</div>
            <div className="text-xs text-muted-foreground">Links</div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Create Workspace Page ──────────────────────────────────────────────────

function CreateWorkspacePage({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { token } = useAuth()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await apiFetch('/workspaces', token, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'App created!', description: `${name} is ready to integrate.` })
        onNavigate({ name: 'workspace', workspaceId: data.workspace.id })
      } else {
        toast({ title: 'Error', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to create workspace', variant: 'destructive' })
    }
    setLoading(false)
  }

  return (
    <div className="max-w-md mx-auto">
      <Button variant="ghost" onClick={() => onNavigate({ name: 'dashboard' })} className="mb-4">
        ← Back
      </Button>
      <Card>
        <CardHeader>
          <CardTitle>Create New App</CardTitle>
          <CardDescription>
            Each app gets its own API key, payout accounts, and payment links.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ws-name">App Name</Label>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. FitLife Hub, My Shop, etc."
                required
                minLength={2}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Create App
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Workspace Detail Page (tabs) ───────────────────────────────────────────

function WorkspacePage({
  workspaceId,
  initialTab,
  onNavigate,
}: {
  workspaceId: string
  initialTab: string
  onNavigate: (p: Page) => void
}) {
  const { token } = useAuth()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [tab, setTab] = useState(initialTab)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    apiFetch(`/workspaces/${workspaceId}`, token)
      .then(res => res.json())
      .then(data => {
        if (data.success) setWorkspace(data.workspace)
      })
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!workspace) {
    return <div>Workspace not found</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 bg-muted rounded-xl flex items-center justify-center">
          <Building2 className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">{workspace.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="secondary">{workspace.tier}</Badge>
            <span className="text-sm text-muted-foreground">
              {workspace.verificationCredits} verification credits
            </span>
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-3 md:grid-cols-8 lg:w-fit">
          <TabsTrigger value="overview"><BarChart3 className="w-4 h-4 mr-1" />Overview</TabsTrigger>
          <TabsTrigger value="api-keys"><Key className="w-4 h-4 mr-1" />API Keys</TabsTrigger>
          <TabsTrigger value="payouts"><Wallet className="w-4 h-4 mr-1" />Payouts</TabsTrigger>
          <TabsTrigger value="links"><Link2 className="w-4 h-4 mr-1" />Links</TabsTrigger>
          <TabsTrigger value="products"><ShoppingCart className="w-4 h-4 mr-1" />Products</TabsTrigger>
          <TabsTrigger value="payments"><CreditCard className="w-4 h-4 mr-1" />Payments</TabsTrigger>
          <TabsTrigger value="webhooks"><Webhook className="w-4 h-4 mr-1" />Webhooks</TabsTrigger>
          <TabsTrigger value="settings"><Settings className="w-4 h-4 mr-1" />Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="api-keys" className="mt-6">
          <ApiKeysTab workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="payouts" className="mt-6">
          <PayoutsTab workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="links" className="mt-6">
          <PaymentLinksTab workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="products" className="mt-6">
          <ProductsTab workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="payments" className="mt-6">
          <PaymentsTab workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="webhooks" className="mt-6">
          <WebhooksTab workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="settings" className="mt-6">
          <SettingsTab workspace={workspace} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ─── Overview Tab (stats + revenue chart) ────────────────────────────────────

function OverviewTab({ workspaceId }: { workspaceId: string }) {
  const { token } = useAuth()
  const [stats, setStats] = useState<WorkspaceStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch(`/workspaces/${workspaceId}/stats`, token)
      .then(res => res.json())
      .then(data => {
        if (data.success) setStats(data.stats)
      })
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  if (loading) return <Loader2 className="w-6 h-6 animate-spin" />
  if (!stats) return <div>No stats available</div>

  const maxRevenue = Math.max(...stats.dailyRevenue.map(d => d.revenue), 1)

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Revenue</CardTitle>
            <DollarSign className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalRevenue.toLocaleString()} ETB</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Payments</CardTitle>
            <ShoppingCart className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalPayments}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Revenue (30d)</CardTitle>
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.revenue30Days.toLocaleString()} ETB</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Payments (30d)</CardTitle>
            <CreditCard className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.payments30Days}</div>
          </CardContent>
        </Card>
      </div>

      {/* Revenue chart (simple bar chart) */}
      <Card>
        <CardHeader>
          <CardTitle>Revenue (Last 30 Days)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-1 h-48">
            {stats.dailyRevenue.map((day, i) => (
              <div
                key={i}
                className="flex-1 bg-primary/80 hover:bg-primary rounded-t transition-colors min-w-[4px]"
                style={{ height: `${(day.revenue / maxRevenue) * 100}%`, minHeight: '2px' }}
                title={`${day.date}: ${day.revenue} ETB (${day.count} payments)`}
              />
            ))}
          </div>
          <div className="flex justify-between mt-2 text-xs text-muted-foreground">
            <span>{stats.dailyRevenue[0]?.date}</span>
            <span>{stats.dailyRevenue[stats.dailyRevenue.length - 1]?.date}</span>
          </div>
        </CardContent>
      </Card>

      {/* Provider breakdown */}
      {Object.keys(stats.providerStats).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Payments by Provider</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(stats.providerStats).map(([provider, data]) => (
                <div key={provider} className="flex items-center justify-between">
                  <span className="capitalize">{provider}</span>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-muted-foreground">{data.count} payments</span>
                    <span className="font-bold">{data.revenue.toLocaleString()} ETB</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── API Keys Tab ───────────────────────────────────────────────────────────

function ApiKeysTab({ workspaceId }: { workspaceId: string }) {
  const { token } = useAuth()
  const { toast } = useToast()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(() => {
    apiFetch(`/dashboard/${workspaceId}/api-keys`, token)
      .then(res => res.json())
      .then(data => {
        if (data.success) setKeys(data.apiKeys)
      })
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  useEffect(() => { load() }, [load])

  const createKey = async () => {
    const res = await apiFetch(`/dashboard/${workspaceId}/api-keys`, token, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (data.success) {
      setNewKey(data.apiKey.key)
      setCreateOpen(false)
      load()
      toast({ title: 'API key created', description: 'Copy it now — you won\'t see it again.' })
    }
  }

  const revokeKey = async (keyId: string) => {
    if (!confirm('Revoke this API key? Apps using it will stop working immediately.')) return
    await apiFetch(`/dashboard/${workspaceId}/api-keys/${keyId}`, token, { method: 'DELETE' })
    load()
    toast({ title: 'API key revoked' })
  }

  const copyKey = () => {
    navigator.clipboard.writeText(newKey || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">API Keys</h2>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Generate Key
        </Button>
      </div>

      {newKey && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              New API Key
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <code className="flex-1 p-2 bg-muted rounded text-sm break-all">{newKey}</code>
              <Button size="sm" onClick={copyKey}>
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              ⚠️ Copy this key now. You will not be able to view it again.
            </p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setNewKey(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin" />
      ) : keys.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No API keys yet. Generate one to start integrating.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {keys.map(key => (
            <Card key={key.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
                    <Key className="w-5 h-5" />
                  </div>
                  <div>
                    <code className="text-sm font-mono">{key.prefix}</code>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {key.usageCount} uses · Created {new Date(key.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => revokeKey(key.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate New API Key</DialogTitle>
            <DialogDescription>
              This key will have verify + webhook permissions. You can use it in your app's
              backend to verify payments and create payment links.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createKey}>Generate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Payouts Tab ────────────────────────────────────────────────────────────

const PROVIDERS = [
  { id: 'telebirr', label: 'Telebirr', type: 'PHONE' },
  { id: 'cbe', label: 'CBE Bank', type: 'BANK' },
  { id: 'cbebirr', label: 'CBE Birr', type: 'PHONE' },
  { id: 'dashen', label: 'Dashen Bank', type: 'BANK' },
  { id: 'abyssinia', label: 'Bank of Abyssinia', type: 'BANK' },
  { id: 'awash', label: 'Awash Bank', type: 'BANK' },
  { id: 'zemen', label: 'Zemen Bank', type: 'BANK' },
  { id: 'mpesa', label: 'M-Pesa', type: 'PHONE' },
]

function PayoutsTab({ workspaceId }: { workspaceId: string }) {
  const { token } = useAuth()
  const { toast } = useToast()
  const [payouts, setPayouts] = useState<PayoutAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({
    label: '',
    accountHolderName: '',
    type: 'PHONE' as 'PHONE' | 'BANK',
    account: '',
    providersAllowed: [] as string[],
  })

  const load = useCallback(() => {
    apiFetch(`/dashboard/${workspaceId}/payouts`, token)
      .then(res => res.json())
      .then(data => {
        if (data.success) setPayouts(data.payouts)
      })
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  useEffect(() => { load() }, [load])

  const create = async () => {
    const res = await apiFetch(`/dashboard/${workspaceId}/payouts`, token, {
      method: 'POST',
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (data.success) {
      toast({ title: 'Payout account created' })
      setCreateOpen(false)
      setForm({ label: '', accountHolderName: '', type: 'PHONE', account: '', providersAllowed: [] })
      load()
    } else {
      toast({ title: 'Error', description: data.error, variant: 'destructive' })
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this payout account?')) return
    await apiFetch(`/dashboard/${workspaceId}/payouts/${id}`, token, { method: 'DELETE' })
    load()
    toast({ title: 'Payout account deleted' })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Payout Accounts</h2>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Add Account
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        These are the bank accounts / phone numbers where payments should be sent.
        When a buyer pays, the platform checks that the money went to one of these accounts.
      </p>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin" />
      ) : payouts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No payout accounts yet. Add one to start receiving payments.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {payouts.map(p => (
            <Card key={p.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
                    <Wallet className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-semibold">{p.label}</div>
                    <div className="text-sm text-muted-foreground">
                      {p.accountHolderName} · {p.type === 'PHONE' ? '📱' : '🏦'} {p.account}
                    </div>
                    <div className="flex gap-1 mt-1">
                      {(p.providersAllowed as string[]).map(pr => (
                        <Badge key={pr} variant="secondary" className="text-xs capitalize">{pr}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => remove(p.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Payout Account</DialogTitle>
            <DialogDescription>Where should payments be sent?</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Label</Label>
              <Input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="e.g. Main Telebirr" />
            </div>
            <div className="space-y-2">
              <Label>Account Holder Name</Label>
              <Input value={form.accountHolderName} onChange={e => setForm({ ...form, accountHolderName: e.target.value })} placeholder="Your name" />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as 'PHONE' | 'BANK' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PHONE">📱 Phone (Telebirr / CBE Birr / M-Pesa)</SelectItem>
                  <SelectItem value="BANK">🏦 Bank (CBE / Dashen / Abyssinia / Awash / Zemen)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{form.type === 'PHONE' ? 'Phone Number' : 'Account Number'}</Label>
              <Input value={form.account} onChange={e => setForm({ ...form, account: e.target.value })} placeholder={form.type === 'PHONE' ? '09xxxxxxxx' : 'Bank account number'} />
            </div>
            <div className="space-y-2">
              <Label>Accepted Providers</Label>
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.filter(p => p.type === form.type).map(p => (
                  <Badge
                    key={p.id}
                    variant={form.providersAllowed.includes(p.id) ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => {
                      setForm({
                        ...form,
                        providersAllowed: form.providersAllowed.includes(p.id)
                          ? form.providersAllowed.filter(x => x !== p.id)
                          : [...form.providersAllowed, p.id],
                      })
                    }}
                  >
                    {p.label}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.label || !form.accountHolderName || !form.account || form.providersAllowed.length === 0}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Payment Links Tab ──────────────────────────────────────────────────────

function PaymentLinksTab({ workspaceId }: { workspaceId: string }) {
  const { token } = useAuth()
  const { toast } = useToast()
  const [links, setLinks] = useState<PaymentLink[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    fixedAmount: 299,
    acceptedProviders: ['telebirr'] as string[],
    redirectUrl: '',
  })

  const load = useCallback(() => {
    apiFetch(`/dashboard/${workspaceId}/payment-links`, token)
      .then(res => res.json())
      .then(data => {
        if (data.success) setLinks(data.paymentLinks)
      })
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  useEffect(() => { load() }, [load])

  const create = async () => {
    const res = await apiFetch(`/dashboard/${workspaceId}/payment-links`, token, {
      method: 'POST',
      body: JSON.stringify({
        ...form,
        redirectUrl: form.redirectUrl || undefined,
      }),
    })
    const data = await res.json()
    if (data.success) {
      toast({ title: 'Payment link created!' })
      setCreateOpen(false)
      setForm({ name: '', fixedAmount: 299, acceptedProviders: ['telebirr'], redirectUrl: '' })
      load()
    } else {
      toast({ title: 'Error', description: data.error, variant: 'destructive' })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Payment Links</h2>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Create Link
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Hosted payment pages. Share the link with buyers — they pay via Telebirr/CBE/etc.,
        get verified automatically, and are redirected back to your app.
      </p>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin" />
      ) : links.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No payment links yet. Create one to start collecting payments.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {links.map(link => (
            <Card key={link.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
                    <Link2 className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-semibold">{link.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {link.fixedAmount} ETB · {link._count?.orders ?? 0} payments ·{' '}
                      {new Date(link.createdAt).toLocaleDateString()}
                    </div>
                    <div className="flex gap-1 mt-1">
                      {(link.acceptedProviders as string[]).map(pr => (
                        <Badge key={pr} variant="secondary" className="text-xs capitalize">{pr}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-muted-foreground hidden md:block">
                    {typeof window !== 'undefined' ? `${window.location.origin}/pl/${link.id}` : `/pl/${link.id}`}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/pl/${link.id}`)
                      toast({ title: 'Link copied!' })
                    }}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Payment Link</DialogTitle>
            <DialogDescription>Buyers visit this hosted page to pay.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Link Name</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Monthly Subscription" />
            </div>
            <div className="space-y-2">
              <Label>Amount (ETB)</Label>
              <Input type="number" value={form.fixedAmount} onChange={e => setForm({ ...form, fixedAmount: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="space-y-2">
              <Label>Accepted Providers</Label>
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.map(p => (
                  <Badge
                    key={p.id}
                    variant={form.acceptedProviders.includes(p.id) ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => {
                      setForm({
                        ...form,
                        acceptedProviders: form.acceptedProviders.includes(p.id)
                          ? form.acceptedProviders.filter(x => x !== p.id)
                          : [...form.acceptedProviders, p.id],
                      })
                    }}
                  >
                    {p.label}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Redirect URL (optional)</Label>
              <Input value={form.redirectUrl} onChange={e => setForm({ ...form, redirectUrl: e.target.value })} placeholder="https://yourapp.com/thank-you" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.name || form.fixedAmount <= 0}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Products Tab ─────────────────────────────────────────────────────────────

function ProductsTab({ workspaceId }: { workspaceId: string }) {
  const { token } = useAuth()
  const { toast } = useToast()
  const [products, setProducts] = useState<Product[]>([])
  const [payouts, setPayouts] = useState<PayoutAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    price: 299,
    acceptedProviders: ['telebirr'] as string[],
    payoutAccountIds: [] as string[],
    maxBuyers: '',
  })

  const load = useCallback(() => {
    Promise.all([
      apiFetch(`/dashboard/${workspaceId}/products`, token).then(res => res.json()),
      apiFetch(`/dashboard/${workspaceId}/payouts`, token).then(res => res.json()),
    ])
      .then(([pData, payData]) => {
        if (pData.success) setProducts(pData.products)
        if (payData.success) setPayouts(payData.payouts)
      })
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  useEffect(() => { load() }, [load])

  const toggleProvider = (id: string) => {
    setForm({
      ...form,
      acceptedProviders: form.acceptedProviders.includes(id)
        ? form.acceptedProviders.filter(x => x !== id)
        : [...form.acceptedProviders, id],
    })
  }

  const togglePayout = (id: string) => {
    setForm({
      ...form,
      payoutAccountIds: form.payoutAccountIds.includes(id)
        ? form.payoutAccountIds.filter(x => x !== id)
        : [...form.payoutAccountIds, id],
    })
  }

  const create = async () => {
    const res = await apiFetch(`/dashboard/${workspaceId}/products`, token, {
      method: 'POST',
      body: JSON.stringify({
        name: form.name,
        price: form.price,
        acceptedProviders: form.acceptedProviders,
        payoutAccountIds: form.payoutAccountIds,
        maxBuyers: form.maxBuyers === '' ? undefined : parseInt(form.maxBuyers) || undefined,
      }),
    })
    const data = await res.json()
    if (data.success) {
      toast({ title: 'Product created! A default payment link was generated.' })
      setCreateOpen(false)
      setForm({ name: '', price: 299, acceptedProviders: ['telebirr'], payoutAccountIds: [], maxBuyers: '' })
      load()
    } else {
      toast({ title: 'Error', description: data.error, variant: 'destructive' })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Products</h2>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Product
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Sellable items with a fixed price. Creating a product also generates its default hosted
        payment link.
      </p>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin" />
      ) : products.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No products yet. Create one to start selling.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {products.map(product => (
            <Card key={product.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
                    <ShoppingCart className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-semibold">{product.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {product.price} ETB · {product._count?.orders ?? 0} orders ·{' '}
                      {product.payoutAccounts.map(a => a.label).join(', ') || 'no payout account'}
                    </div>
                    <div className="flex gap-1 mt-1">
                      {product.acceptedProviders.map(pr => (
                        <Badge key={pr} variant="secondary" className="text-xs capitalize">{pr}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
                <Badge variant={product.active ? 'default' : 'secondary'}>
                  {product.active ? 'active' : 'inactive'}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Product</DialogTitle>
            <DialogDescription>A default payment link is generated automatically.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Product Name</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Monthly Subscription" />
            </div>
            <div className="space-y-2">
              <Label>Price (ETB)</Label>
              <Input type="number" value={form.price} onChange={e => setForm({ ...form, price: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="space-y-2">
              <Label>Accepted Providers</Label>
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.map(p => (
                  <Badge
                    key={p.id}
                    variant={form.acceptedProviders.includes(p.id) ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => toggleProvider(p.id)}
                  >
                    {p.label}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Payout Accounts (one per accepted provider)</Label>
              {payouts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No payout accounts yet — create one in the Payouts tab first.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {payouts.map(a => (
                    <Badge
                      key={a.id}
                      variant={form.payoutAccountIds.includes(a.id) ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => togglePayout(a.id)}
                    >
                      {a.label}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>Max buyers (optional)</Label>
              <Input type="number" value={form.maxBuyers} onChange={e => setForm({ ...form, maxBuyers: e.target.value })} placeholder="Unlimited" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={create}
              disabled={!form.name || form.price <= 0 || form.payoutAccountIds.length === 0}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Payments Tab ───────────────────────────────────────────────────────────

function PaymentsTab({ workspaceId }: { workspaceId: string }) {
  const { token } = useAuth()
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch(`/workspaces/${workspaceId}/payments?limit=50`, token)
      .then(res => res.json())
      .then(data => {
        if (data.success) setPayments(data.payments)
      })
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  if (loading) return <Loader2 className="w-6 h-6 animate-spin" />

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Recent Payments</h2>
      {payments.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No payments yet. Once buyers start paying, they'll appear here.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="text-left p-3 font-medium">Reference</th>
                    <th className="text-left p-3 font-medium">Provider</th>
                    <th className="text-left p-3 font-medium">Buyer</th>
                    <th className="text-right p-3 font-medium">Amount</th>
                    <th className="text-left p-3 font-medium">Date</th>
                    <th className="text-left p-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id} className="border-b hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">{p.reference}</td>
                      <td className="p-3 capitalize">{p.provider}</td>
                      <td className="p-3">{p.buyerName || p.buyerEmail || '—'}</td>
                      <td className="p-3 text-right font-bold">{p.amountPaid} ETB</td>
                      <td className="p-3 text-muted-foreground">{new Date(p.createdAt).toLocaleDateString()}</td>
                      <td className="p-3">
                        <Badge variant={p.status === 'PAID' ? 'default' : 'secondary'}>{p.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── Webhooks Tab ───────────────────────────────────────────────────────────

// Must match VALID_EVENTS in the API (src/routes/webhooks.ts) — unknown event
// names are rejected with 400.
const WEBHOOK_EVENTS = [
  'payment_link.paid',
  'verification.success',
  'verification.failed',
  'product.sold_out',
  'webhook.dead_letter',
]

function WebhooksTab({ workspaceId }: { workspaceId: string }) {
  const { token } = useAuth()
  const { toast } = useToast()
  const [webhooks, setWebhooks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ url: '', events: ['payment_link.paid'] })
  const [newSecret, setNewSecret] = useState<string | null>(null)

  const load = useCallback(() => {
    apiFetch(`/dashboard/${workspaceId}/webhooks`, token)
      .then(res => res.json())
      .then(data => {
        if (data.success) setWebhooks(data.webhooks)
      })
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  useEffect(() => { load() }, [load])

  const create = async () => {
    const res = await apiFetch(`/dashboard/${workspaceId}/webhooks`, token, {
      method: 'POST',
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (data.success) {
      setNewSecret(data.webhook.signingSecret)
      setCreateOpen(false)
      setForm({ url: '', events: ['payment_link.paid'] })
      load()
      toast({ title: 'Webhook created' })
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this webhook?')) return
    await apiFetch(`/dashboard/${workspaceId}/webhooks/${id}`, token, { method: 'DELETE' })
    load()
    toast({ title: 'Webhook deleted' })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Webhooks</h2>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Add Webhook
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        When a payment is verified, the platform sends a POST request to your webhook URL.
        Use this to automatically grant access, send emails, or trigger any workflow.
      </p>

      {newSecret && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              Webhook Signing Secret
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <code className="flex-1 p-2 bg-muted rounded text-sm break-all">{newSecret}</code>
              <Button size="sm" onClick={() => {
                navigator.clipboard.writeText(newSecret)
                toast({ title: 'Copied!' })
              }}>
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Use this secret to verify webhook signatures in your app.
            </p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setNewSecret(null)}>Dismiss</Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin" />
      ) : webhooks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No webhooks configured. Add one to receive real-time payment notifications.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {webhooks.map(wh => (
            <Card key={wh.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
                    <Webhook className="w-5 h-5" />
                  </div>
                  <div>
                    <code className="text-sm">{wh.url}</code>
                    <div className="flex gap-1 mt-1">
                      {(wh.events as string[]).map(ev => (
                        <Badge key={ev} variant="secondary" className="text-xs">{ev}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => remove(wh.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Webhook</DialogTitle>
            <DialogDescription>Your app will receive POST requests when events fire.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Webhook URL</Label>
              <Input value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} placeholder="https://yourapp.com/api/webhook" />
            </div>
            <div className="space-y-2">
              <Label>Events</Label>
              <div className="flex flex-wrap gap-2">
                {WEBHOOK_EVENTS.map(ev => (
                  <Badge
                    key={ev}
                    variant={form.events.includes(ev) ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => {
                      setForm({
                        ...form,
                        events: form.events.includes(ev)
                          ? form.events.filter(x => x !== ev)
                          : [...form.events, ev],
                      })
                    }}
                  >
                    {ev}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.url}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

function SettingsTab({ workspace }: { workspace: Workspace }) {
  const { token } = useAuth()
  const { toast } = useToast()
  const [name, setName] = useState(workspace.name)
  const [saving, setSaving] = useState(false)

  const rename = async () => {
    if (!name.trim() || name.trim() === workspace.name) return
    setSaving(true)
    try {
      const res = await apiFetch(`/workspaces/${workspace.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Workspace renamed. Refresh to see the new name.' })
      } else {
        toast({ title: 'Error', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to rename workspace.', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Settings</h2>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between"><span className="text-muted-foreground">ID</span><code className="text-sm">{workspace.id}</code></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Tier</span><Badge variant="secondary">{workspace.tier}</Badge></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{new Date(workspace.createdAt).toLocaleDateString()}</span></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rename workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Workspace name" />
            <Button onClick={rename} disabled={saving || !name.trim() || name.trim() === workspace.name}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credits</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between"><span className="text-muted-foreground">Verification credits</span><span className="font-bold">{workspace.verificationCredits}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Image OCR credits</span><span className="font-bold">{workspace.imageCredits}</span></div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Root ───────────────────────────────────────────────────────────────────

export default function Home() {
  return (
    <ToastProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ToastProvider>
  )
}
