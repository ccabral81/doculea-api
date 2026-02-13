// apps/web/pages/_document.tsx
import Document, { Html, Head, Main, NextScript } from "next/document";

export default class MyDocument extends Document {
  render() {
    return (
      <Html lang="en">
        <Head>
          {/* PWA Manifest */}
          <link rel="manifest" href="/manifest.webmanifest" />
          <meta name="theme-color" content="#1E40AF" />

          {/* iOS PWA */}
          <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-status-bar-style" content="default" />

          {/* Optional: nicer iOS title */}
          <meta name="apple-mobile-web-app-title" content="Docu-Lea" />
        </Head>

        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

