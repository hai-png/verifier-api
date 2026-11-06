'use client'

// ─── Notifications Tab ───────────────────────────────────────────────────────

// Full CRUD over notification channels, which until now had a complete API
// (src/routes/notifications.ts) and a docs page but no UI at all — a plan-gated
// feature that was unreachable from the product.
//
// The handlers are the API's own, reached through new session-authenticated
// routes in dashboard.ts, so the plan limit, destination validation and
// event-name rules have exactly one definition rather than a second copy that
// drifts. Sharing this file's apiFetch/readJson/useAuth/ReadOnlyNotice goes
// through getSharedTabDeps() — page.tsx owns them, and importing page.tsx from
// here would be circular.
import { useCallback, useEffect, useState } from 'react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleChip } from '@/components/ui/toggle-chip'
import { Loader2, Lock, Plus, Send, Pause, Play, Trash2 } from 'lucide-react'

import { getSharedTabDeps } from './tab-deps'

const NOTIFICATION_EVENTS = [
  'payment_link.paid',
  'verification.success',
  'verification.failed',
  'product.sold_out',
  'webhook.dead_letter',
]

interface NotificationChannel {
  id: string
  type: 'EMAIL' | 'TELEGRAM'
  label: string | null
  destination: string
  events: string[]
  active: boolean
  createdAt: string
}

export function NotificationsTab({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const { apiFetch, readJson, useAuth, useToast, ReadOnlyNotice } = getSharedTabDeps()
  const { token } = useAuth()
  const { toast } = useToast()
  const [channels, setChannels] = useState<NotificationChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    type: 'EMAIL' as 'EMAIL' | 'TELEGRAM',
    label: '',
    destination: '',
    events: ['payment_link.paid', 'verification.failed'] as string[],
  })
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    apiFetch(`/dashboard/${workspaceId}/notifications`, token)
      .then(readJson)
      .then(data => {
        if (data.success) setChannels(data.channels ?? [])
      })
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Could not load notification channels.'))
      .finally(() => setLoading(false))
  }, [token, workspaceId])

  useEffect(() => { load() }, [load])

  const toggleEvent = (ev: string) => {
    setForm(prev => ({
      ...prev,
      events: prev.events.includes(ev)
        ? prev.events.filter(x => x !== ev)
        // Never let the selection empty: the API rejects a zero-event array,
        // and a user unchecking the last chip got a 400 with no way to see why
        // the button had been fine a moment earlier.
        : [...prev.events, ev],
    }))
  }

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const res = await apiFetch(`/dashboard/${workspaceId}/notifications`, token, {
        method: 'POST',
        body: JSON.stringify({ ...form, label: form.label || undefined }),
      })
      const data = await readJson(res)
      if (data.success) {
        toast({ title: 'Notification channel created' })
        setCreateOpen(false)
        setForm({ type: 'EMAIL', label: '', destination: '', events: ['payment_link.paid', 'verification.failed'] })
        load()
      } else {
        toast({ title: 'Could not create channel', description: data.error, variant: 'destructive' })
      }
    } catch (err) {
      toast({
        title: 'Could not create channel',
        description: err instanceof Error ? err.message : 'Network error.',
        variant: 'destructive',
      })
    } finally {
      setCreating(false)
    }
  }

  const toggleActive = async (channel: NotificationChannel) => {
    setTogglingId(channel.id)
    try {
      const res = await apiFetch(`/dashboard/${workspaceId}/notifications/${channel.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ active: !channel.active }),
      })
      const data = await readJson(res)
      if (data.success) {
        load()
        toast({ title: channel.active ? 'Channel paused' : 'Channel resumed' })
      } else {
        toast({ title: 'Could not update channel', description: data.error, variant: 'destructive' })
      }
    } catch (err) {
      toast({
        title: 'Could not update channel',
        description: err instanceof Error ? err.message : 'Network error.',
        variant: 'destructive',
      })
    } finally {
      setTogglingId(null)
    }
  }

  const sendTest = async (channel: NotificationChannel) => {
    setTestingId(channel.id)
    try {
      const res = await apiFetch(`/dashboard/${workspaceId}/notifications/${channel.id}/test`, token, {
        method: 'POST',
      })
      const data = await readJson(res)
      if (data.success) {
        // Queued, not delivered. Saying otherwise would send someone looking
        // for a message that legitimately has not arrived yet.
        toast({
          title: 'Test queued',
          description: 'Delivery is asynchronous — if nothing arrives within a minute, check the destination.',
        })
      } else {
        toast({ title: 'Test failed', description: data.error, variant: 'destructive' })
      }
    } catch (err) {
      toast({
        title: 'Test failed',
        description: err instanceof Error ? err.message : 'Network error.',
        variant: 'destructive',
      })
    } finally {
      setTestingId(null)
    }
  }

  const remove = async (channel: NotificationChannel) => {
    if (!confirm(`Delete the ${channel.type === 'EMAIL' ? 'email' : 'Telegram'} channel for ${channel.destination}?`)) return
    setRemovingId(channel.id)
    try {
      const res = await apiFetch(`/dashboard/${workspaceId}/notifications/${channel.id}`, token, { method: 'DELETE' })
      const data = await readJson(res)
      if (!res.ok || !data.success) {
        toast({ title: 'Could not delete channel', description: data.error, variant: 'destructive' })
        return
      }
      load()
      toast({ title: 'Channel deleted' })
    } catch (err) {
      toast({
        title: 'Could not delete channel',
        description: err instanceof Error ? err.message : 'Network error.',
        variant: 'destructive',
      })
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Notifications</h2>
        {canManage ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add Channel
          </Button>
        ) : (
          <Badge variant="outline" className="flex items-center gap-1">
            <Lock className="w-3 h-3" />
            Read only
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Get an email or Telegram message when something happens in this workspace. Delivery is
        asynchronous and runs on the queue backend, so a paused or unreachable queue silently stops
        alerts without affecting verifications.
      </p>
      {!canManage && <ReadOnlyNotice what="adding, editing or deleting channels" />}

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin" />
      ) : loadError ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </CardContent>
        </Card>
      ) : channels.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <p className="text-muted-foreground">No notification channels yet.</p>
            {canManage && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Add your first channel
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {channels.map(ch => (
            <Card key={ch.id} className={ch.active ? '' : 'opacity-60'}>
              <CardContent className="py-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="text-xs">
                      {ch.type === 'EMAIL' ? '✉ Email' : 'Telegram'}
                    </Badge>
                    {ch.label && <span className="font-medium">{ch.label}</span>}
                    {!ch.active && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">paused</Badge>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground break-all">{ch.destination}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {ch.events.map(ev => (
                      <Badge key={ev} variant="outline" className="text-xs font-mono">{ev}</Badge>
                    ))}
                  </div>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={testingId === ch.id || !ch.active}
                      onClick={() => sendTest(ch)}
                      title="Send a test notification"
                    >
                      {testingId === ch.id
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Send className="w-4 h-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={togglingId === ch.id}
                      onClick={() => toggleActive(ch)}
                      title={ch.active ? 'Pause deliveries' : 'Resume deliveries'}
                    >
                      {togglingId === ch.id
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : ch.active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={removingId === ch.id}
                      onClick={() => remove(ch)}
                    >
                      {removingId === ch.id
                        ? <Loader2 className="w-4 h-4 animate-spin text-destructive" />
                        : <Trash2 className="w-4 h-4 text-destructive" />}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Notification Channel</DialogTitle>
            <DialogDescription>Where should workspace events be sent?</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="notif-type">Type</Label>
              <Select
                value={form.type}
                onValueChange={v => setForm({ ...form, type: v as 'EMAIL' | 'TELEGRAM', destination: '' })}
              >
                <SelectTrigger id="notif-type">
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMAIL">✉ Email</SelectItem>
                  <SelectItem value="TELEGRAM">Telegram</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notif-destination">
                {form.type === 'EMAIL' ? 'Email address' : 'Chat ID or @username'}
              </Label>
              <Input
                id="notif-destination"
                value={form.destination}
                onChange={e => setForm({ ...form, destination: e.target.value })}
                placeholder={form.type === 'EMAIL' ? 'you@example.com' : '123456789 or @yourchannel'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notif-label">Label (optional)</Label>
              <Input
                id="notif-label"
                value={form.label}
                onChange={e => setForm({ ...form, label: e.target.value })}
                placeholder="e.g. Ops alerts"
              />
            </div>
            <div className="space-y-2">
              <Label>Events</Label>
              <div className="flex flex-wrap gap-2">
                {NOTIFICATION_EVENTS.map(ev => (
                  <ToggleChip
                    key={ev}
                    selected={form.events.includes(ev)}
                    onClick={() => toggleEvent(ev)}
                  >
                    {ev}
                  </ToggleChip>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            <Button
              onClick={create}
              disabled={!form.destination || form.events.length === 0 || creating}
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}