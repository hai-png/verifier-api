"use client"

import { useEffect, useState } from "react"
import { Loader2, LogOut, LayoutDashboard, ShieldCheck } from "lucide-react"
import VerifyForm from "@/components/VerifyForm"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://verifier-api-selfhosted.onrender.com"

type SessionUser = {
  id: string
  email: string
  name: string
  currentWorkspaceId?: string | null
}

type Workspace = {
  id: string
  name: string
  verificationCredits: number
  role: string
}

export default function VerifyPage() {
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState("")

  useEffect(() => {
    const sessionToken = localStorage.getItem("noveld_token")
    if (!sessionToken) {
      setLoading(false)
      return
    }

    fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!data?.success || !data.user) {
          localStorage.removeItem("noveld_token")
          return
        }

        const availableWorkspaces = (data.workspaces ?? []) as Workspace[]
        setToken(sessionToken)
        setUser(data.user as SessionUser)
        setWorkspaces(availableWorkspaces)
        setWorkspaceId(
          data.user.currentWorkspaceId && availableWorkspaces.some((item: Workspace) => item.id === data.user.currentWorkspaceId)
            ? data.user.currentWorkspaceId
            : availableWorkspaces[0]?.id ?? "",
        )
      })
      .catch(() => {
        localStorage.removeItem("noveld_token")
      })
      .finally(() => setLoading(false))
  }, [])

  async function logout() {
    if (token) {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined)
    }
    localStorage.removeItem("noveld_token")
    window.location.href = "/"
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!user || !token) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 bg-primary rounded-xl flex items-center justify-center mb-3 text-primary-foreground">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>Payment verification is available from the authenticated dashboard only.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <a href="/">Go to dashboard login</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b bg-card sticky top-0 z-50">
        <div className="container mx-auto px-4 max-w-7xl flex items-center justify-between h-14">
          <a href="/" className="flex items-center gap-2 font-bold text-lg">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center text-primary-foreground">
              <ShieldCheck className="w-4 h-4" />
            </div>
            Noveld Pay
          </a>
          <div className="flex items-center gap-2">
            <a href="/" className="inline-flex items-center rounded-md px-3 py-2 text-sm hover:bg-muted">
              <LayoutDashboard className="w-4 h-4 mr-2" /> Dashboard
            </a>
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut className="w-4 h-4 mr-2" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8 max-w-4xl">
        <div className="flex flex-col gap-4 mb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Payment verification</h1>
            <p className="text-muted-foreground mt-1">Signed in as {user.name || user.email}</p>
          </div>
          {workspaces.length > 1 && (
            <div className="space-y-2 sm:min-w-64">
              <label htmlFor="verify-workspace" className="text-sm font-medium">Workspace</label>
              <select
                id="verify-workspace"
                value={workspaceId}
                onChange={event => setWorkspaceId(event.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring"
              >
                {workspaces.map(workspace => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {workspaceId ? (
          <VerifyForm workspaceId={workspaceId} token={token} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Create a workspace first</CardTitle>
              <CardDescription>Verification uses a workspace quota and requires at least one workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild><a href="/">Open dashboard</a></Button>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}
