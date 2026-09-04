import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const jetbrains = JetBrains_Mono({ variable: '--font-mono-stack', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'LEAKPROOF — Revenue Recovery Control Tower',
  description:
    'Classifies failed payments as systemic or idiosyncratic, routes recovery through a policy gate, and proves incremental revenue against a held-out control group.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrains.variable} antialiased`}>{children}</body>
    </html>
  );
}
