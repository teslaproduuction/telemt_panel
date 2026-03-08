import { useState, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { ErrorAlert } from '@/components/ErrorAlert';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { UserFormDialog } from '@/components/UserFormDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { usePolling } from '@/hooks/usePolling';
import { telemt, ApiError } from '@/lib/api';
import { Copy, Plus, Pencil, Trash2, Check } from 'lucide-react';
import { formatBytes } from '@/lib/utils';

interface UserLinks {
  classic?: string[];
  secure?: string[];
  tls?: string[];
}

interface UserInfo {
  username: string;
  user_ad_tag?: string;
  max_tcp_conns?: number;
  expiration_rfc3339?: string;
  data_quota_bytes?: number;
  max_unique_ips?: number;
  current_connections: number;
  active_unique_ips: number;
  recent_unique_ips: number;
  total_octets: number;
  links?: UserLinks;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts (HTTP)
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore copy failures
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-background hover:bg-surface-hover text-text-secondary hover:text-text-primary transition-colors"
      title={label || 'Copy'}
    >
      {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}

interface LinkEntry {
  url: string;
  label: string;
}

function collectLinks(links?: UserLinks): LinkEntry[] {
  const result: LinkEntry[] = [];
  if (!links) return result;
  if (links.tls) {
    for (const url of links.tls) result.push({ url, label: 'TLS' });
  }
  if (links.secure) {
    for (const url of links.secure) result.push({ url, label: 'Secure' });
  }
  if (links.classic) {
    for (const url of links.classic) result.push({ url, label: 'Classic' });
  }
  return result;
}

export function UsersPage() {
  const { data: users, error, loading, refresh } = usePolling<UserInfo[]>(
    () => telemt.get('/v1/users'),
    10000
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserInfo | null>(null);
  const [deleteUser, setDeleteUser] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState('');

  const handleCreate = useCallback(async (data: Record<string, unknown>) => {
    await telemt.post('/v1/users', data);
    refresh();
  }, [refresh]);

  const handleEdit = useCallback(async (data: Record<string, unknown>) => {
    if (!editUser) return;
    await telemt.patch(`/v1/users/${editUser.username}`, data);
    refresh();
  }, [editUser, refresh]);

  const handleDelete = useCallback(async () => {
    if (!deleteUser) return;
    setDeleting(true);
    setActionError('');
    try {
      await telemt.delete(`/v1/users/${deleteUser}`);
      setDeleteUser(null);
      refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }, [deleteUser, refresh]);

  return (
    <div>
      <Header title="Users" refreshing={loading} onRefresh={refresh} />

      <div className="p-6 space-y-4">
        {error && <ErrorAlert message={error.message} onRetry={refresh} />}
        {actionError && <ErrorAlert message={actionError} />}

        <div className="flex justify-end">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} className="mr-1.5" />
            Create User
          </Button>
        </div>

        <div className="border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Proxy Links</TableHead>
                <TableHead>Connections</TableHead>
                <TableHead>Active IPs</TableHead>
                <TableHead>Traffic</TableHead>
                <TableHead>Quota</TableHead>
                <TableHead>Expiration</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(!users || users.length === 0) ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-text-secondary py-8">
                    No users configured
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => {
                  const allLinks = collectLinks(u.links);

                  return (
                    <TableRow key={u.username}>
                      <TableCell className="font-medium">{u.username}</TableCell>
                      <TableCell>
                        {allLinks.length > 0 ? (
                          <div className="flex flex-col gap-1">
                            {allLinks.map((link, i) => (
                              <div key={i} className="flex items-center gap-1">
                                <CopyButton text={link.url} label={link.label} />
                                <CopyButton text={link.url.replace('tg://proxy', 'https://t.me/proxy')} label="t.me" />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-text-secondary text-xs">No links</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.current_connections > 0 ? 'default' : 'outline'}>
                          {u.current_connections}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{u.active_unique_ips}</span>
                        {u.max_unique_ips && (
                          <span className="text-xs text-text-secondary ml-1">/ {u.max_unique_ips}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{formatBytes(u.total_octets)}</Badge>
                      </TableCell>
                      <TableCell>
                        {u.data_quota_bytes ? (
                          <Badge variant="outline">{formatBytes(u.data_quota_bytes)}</Badge>
                        ) : (
                          <span className="text-text-secondary">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {u.expiration_rfc3339 ? (
                          <span className="text-xs">{new Date(u.expiration_rfc3339).toLocaleDateString()}</span>
                        ) : (
                          <span className="text-text-secondary">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => setEditUser(u)}
                            className="p-1.5 rounded text-text-secondary hover:text-accent hover:bg-surface-hover"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => setDeleteUser(u.username)}
                            className="p-1.5 rounded text-text-secondary hover:text-danger hover:bg-surface-hover"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <UserFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
        mode="create"
      />

      <UserFormDialog
        open={!!editUser}
        onClose={() => setEditUser(null)}
        onSubmit={handleEdit}
        initialData={editUser ?? undefined}
        mode="edit"
      />

      <ConfirmDialog
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        onConfirm={handleDelete}
        title="Delete User"
        message={`Are you sure you want to delete user "${deleteUser}"? This action cannot be undone.`}
        loading={deleting}
      />
    </div>
  );
}
