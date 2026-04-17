export const metadata = { title: 'Glute Factoryy' }
export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="theme-color" content="#07090f" />
      </head>
      <body style={{ margin: 0, background: '#07090f' }}>{children}</body>
    </html>
  )
}
