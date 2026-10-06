/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "/Users/l1nzx/Data/05_program/pythonProject/BDMP/db_loc_agent/web-ui/index.html",
    "/Users/l1nzx/Data/05_program/pythonProject/BDMP/db_loc_agent/web-ui/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#0f0f12',
        foreground: '#e4e4e9',
        card: '#16161b',
        'card-foreground': '#e4e4e9',
        primary: '#6366f1',
        'primary-foreground': '#ffffff',
        secondary: '#1e1e26',
        'secondary-foreground': '#e4e4e9',
        muted: '#1e1e26',
        'muted-foreground': '#8b8b9e',
        accent: '#1e1e26',
        'accent-foreground': '#e4e4e9',
        destructive: '#ef4444',
        'destructive-foreground': '#ffffff',
        border: '#252530',
        input: '#1a1a22',
        ring: '#6366f1',
      },
      borderRadius: {
        lg: '0.75rem',
        md: '0.5rem',
        sm: '0.25rem',
      },
    },
  },
  plugins: [],
}
