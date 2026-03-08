import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, Activity, Shield, Network, ArrowUpCircle, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/users', icon: Users, label: 'Users' },
  { to: '/runtime', icon: Activity, label: 'Runtime' },
  { to: '/security', icon: Shield, label: 'Security' },
  { to: '/upstreams', icon: Network, label: 'Upstreams & DCs' },
  { to: '/update', icon: ArrowUpCircle, label: 'Update' },
];

export function Sidebar() {
  const { logout, username } = useAuth();

  return (
    <aside className="w-60 h-screen bg-surface border-r border-border flex flex-col fixed left-0 top-0">
      <div className="p-4 border-b border-border">
        <h1 className="text-lg font-bold text-text-primary tracking-tight">
          Telemt Panel
        </h1>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              )
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="p-3 border-t border-border">
        <div className="text-xs text-text-secondary mb-2 px-3 truncate">
          {username}
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-text-secondary hover:text-danger hover:bg-surface-hover w-full transition-colors"
        >
          <LogOut size={18} />
          Logout
        </button>
      </div>
    </aside>
  );
}
