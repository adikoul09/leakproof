import type { Metadata } from 'next';
import { IBM_Plex_Mono, Instrument_Serif, Inter } from 'next/font/google';
import './globals.css';

/**
 * Three families, three jobs, no overlap.
 *
 * Serif for headings, sans for anything a person reads or clicks, mono for
 * anything the machine said. The third one is not decoration: a mono label is
 * how an operator tells a field name from a sentence at a glance.
 *
 * Instrument Serif stands in for Canela — Canela is licensed and cannot ship in
 * a public repo. It is the closest high-contrast display serif with an open
 * licence, and like Canela's display cuts it ships one weight only, which is
 * why headings below are set at 400 rather than 600.
 */
const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });

const instrumentSerif = Instrument_Serif({
  variable: '--font-serif-stack',
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-mono-stack',
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LEAKPROOF — Revenue Recovery Control Tower',
  description:
    'Classifies failed payments as systemic or idiosyncratic, routes recovery through a policy gate, and proves incremental revenue against a held-out control group.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${instrumentSerif.variable} ${plexMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
