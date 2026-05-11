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
  title: 'Cushion — Liquidation protection for DeFi loans on Solana',
  description: 'Cushion wraps your Solana DeFi loans, watches them 24/7, and intervenes before liquidator bots do. Sleep through the next cascade.',
  icons: {
    icon: '/brand/Icon_White.svg',
  },
  openGraph: {
    title: 'Cushion — Liquidation protection for DeFi loans',
    description: 'Cushion wraps your Solana DeFi loans, watches them 24/7, and intervenes before liquidator bots do. Sleep through the next cascade.',
    url: 'https://app.cushionfi.xyz',
    siteName: 'Cushion',
    images: [{ url: '/brand/Cover.png', width: 1500, height: 500 }],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cushion — Liquidation protection for DeFi loans',
    description: 'Cushion wraps your Solana DeFi loans, watches them 24/7, and intervenes before liquidator bots do.',
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
