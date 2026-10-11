import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Lume · A little wonder. A lot to watch.', description: 'Independent stories, extraordinary worlds. A premium home for authorized films and series.' };
export default function RootLayout({ children }: Readonly<{children:React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
