/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
          950: '#052e16',
        }
      },
      keyframes: {
        fastFadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        topLoading: {
          '0%': { transform: 'translateX(-100%)' },
          '50%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        progressBar: {
          '0%': { transform: 'scaleX(0)' },
          '70%': { transform: 'scaleX(0.8)' },
          '100%': { transform: 'scaleX(1)' },
        },
      },
      animation: {
        'fade-in': 'fastFadeIn 0.18s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'top-loading': 'topLoading 0.8s ease-in-out infinite',
        'progress-bar': 'progressBar 0.4s ease-out forwards',
      }
    },
  },
  plugins: [],
}
