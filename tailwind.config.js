/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Custom dark theme inspired by VSCode/Terminal - Black/White/Gray
        'nb': {
          'bg': '#0d1117',
          'surface': '#161b22',
          'surface-2': '#21262d',
          'surface-hover': '#1c2128',
          'border': '#30363d',
          'border-hover': '#484f58',
          'card': '#161b22',
          'text': '#c9d1d9',
          'text-muted': '#8b949e',
          'text-secondary': '#6e7681',
          'hover': '#1c2128',
          'accent': '#6e7681',          // 灰色
          'accent-hover': '#8b949e',    // 灰色（亮）
          'accent-secondary': '#6e7681', // 灰色
          'success': '#10b981',
          'warning': '#f59e0b',
          'error': '#f43f5e',
        }
      },
      fontFamily: {
        'mono': ['JetBrains Mono', 'Fira Code', 'Monaco', 'Consolas', 'monospace'],
        'sans': ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}

