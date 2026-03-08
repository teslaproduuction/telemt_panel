import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0f1117',
        surface: '#161b22',
        'surface-hover': '#1c2333',
        border: '#2d333b',
        accent: '#3b82f6',
        'accent-hover': '#2563eb',
        'text-primary': '#e6edf3',
        'text-secondary': '#8b949e',
        success: '#22c55e',
        warning: '#eab308',
        danger: '#ef4444',
      },
    },
  },
  plugins: [],
} satisfies Config
