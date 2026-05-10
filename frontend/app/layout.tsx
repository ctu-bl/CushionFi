import type { Metadata } from 'next';
import { Instrument_Serif, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-display-loaded',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body-loaded',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono-loaded',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Cushion — Insurance for DeFi loans',
  description: 'Liquidation protection for Solana borrowers. Watch positions, deploy buffer capital, give borrowers a controlled exit.',
  icons: {
    icon: '/brand/Icon_White.svg',
  },
  openGraph: {
    title: 'Cushion — Insurance for DeFi loans',
    description: 'Liquidation protection for Solana borrowers.',
    url: 'https://app.cushionfi.xyz',
    siteName: 'Cushion',
    images: [{ url: '/brand/Cover.png', width: 1200, height: 630 }],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cushion — Insurance for DeFi loans',
    description: 'Liquidation protection for Solana borrowers.',
    images: ['/brand/Cover.png'],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${instrumentSerif.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
