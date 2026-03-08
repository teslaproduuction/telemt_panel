import { cn } from '@/lib/utils';

interface MetricCardProps {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const variantClasses = {
  default: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export function MetricCard({ label, value, icon, variant = 'default' }: MetricCardProps) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3 lg:p-4">
      <div className="flex items-center justify-between mb-1.5 lg:mb-2">
        <span className="text-xs lg:text-sm text-text-secondary">{label}</span>
        {icon && <span className="text-text-secondary">{icon}</span>}
      </div>
      <div className={cn('text-xl lg:text-2xl font-bold', variantClasses[variant])}>
        {value}
      </div>
    </div>
  );
}
