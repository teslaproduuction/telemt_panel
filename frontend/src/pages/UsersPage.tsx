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
import { Copy, Eye, EyeOff, Plus, Pencil, Trash2 } from 'lucide-react';
import { formatBytes } from '@/lib/utils';

interface UserInfo {
  username: string;
  secret?: string;
  user_ad_tag?: string;
  max_tcp_conns?: number;
  expiration_rfc3339?: string;
  data_quota_bytes?: number;
  max_unique_ips?: number;
  current_connections: number;
  active_unique_ips: number;
  recent_unique_ips: number;
  total_octets: number;
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
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState('');

  const toggleReveal = (username: string) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const copySecret = async (secret: string) => {
    await navigator.clipboard.writeText(secret);
  };

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
                <TableHead>Secret</TableHead>
                <TableHead>Connections</TableHead>
                <TableHead>Active IPs</TableHead>
                <TableHead>Traffic</TableHead>
                <TableHead>Max Conns</TableHead>
                <TableHead>Quota</TableHead>
                <TableHead>Expiration</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(!users || users.length === 0) ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-text-secondary py-8">
                    No users configured
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.username}>
                    <TableCell className="font-medium">{u.username}</TableCell>
                    <TableCell>
                      {u.secret && (
                        <div className="flex items-center gap-1.5">
                          <code className="text-xs bg-background px-1.5 py-0.5 rounded max-w-[140px] truncate">
                            {revealedSecrets.has(u.username)
                              ? u.secret
                              : '••••••••••••••••'}
                          </code>
                          <button
                            onClick={() => toggleReveal(u.username)}
                            className="text-text-secondary hover:text-text-primary p-0.5"
                          >
                            {revealedSecrets.has(u.username) ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          <button
                            onClick={() => copySecret(u.secret!)}
                            className="text-text-secondary hover:text-text-primary p-0.5"
                          >
                            <Copy size={14} />
                          </button>
                        </div>
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
                    <TableCell>{u.max_tcp_conns ?? <span className="text-text-secondary">-</span>}</TableCell>
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
                ))
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
