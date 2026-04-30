/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary:  '#185FA5',
        surface:  '#F1EFE8',
        border:   '#D3D1C7',
        muted:    '#888780',
      }
    }
  },
  plugins: []
}
